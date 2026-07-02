// =============================================================================
// HostelService — boarding-house management
// =============================================================================
// Tenant-scoped (RLS). Wardens / admins maintain hostels + rooms (with rent and
// arbitrary custom fields), allocate students to rooms, and see one-click bed
// availability. Hostel fees are billed through the SHARED Fees tables
// (Invoice/InvoiceLineItem) so they land on the same student invoice as academic
// fees ("collect alongside academic fees"). Every mutation is audited; room/rent
// changes are audited too so finance can analyse them.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import type { HostelAllocationDto, HostelDto, HostelFeeRunDto, HostelRoomDto, HostelSummaryDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

type Json = Record<string, string>;

@Injectable()
export class HostelService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private cf(v: unknown): Json {
    return (v ?? {}) as Json;
  }

  // --- warden relationship scoping -------------------------------------------
  // school_admin / principal (and an impersonating super_admin) manage EVERY
  // hostel; a warden is confined to the hostel(s) they are assigned to.
  private wide(p: Principal): boolean {
    return p.roles.some((r) => r === "school_admin" || r === "principal" || r === "super_admin");
  }
  /** A warden may only act on their own hostel (404-not-403 for anything else). */
  private async assertHostelInScope(tx: TenantTx, p: Principal, hostelId: string): Promise<void> {
    if (this.wide(p)) return;
    const h = await tx.hostel.findFirst({ where: { id: hostelId }, select: { wardenId: true } });
    if (!h || h.wardenId !== p.userId) throw new NotFoundException("Hostel not found");
  }
  private async hostelIdForRoom(tx: TenantTx, roomId: string): Promise<string | null> {
    return (await tx.hostelRoom.findFirst({ where: { id: roomId }, select: { hostelId: true } }))?.hostelId ?? null;
  }

  // --- hostels --------------------------------------------------------------

  async createHostel(
    p: Principal,
    input: { name: string; type: string; wardenId?: string | null; customFields?: Json },
  ): Promise<HostelDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!this.wide(p)) throw new ForbiddenException("Only an administrator can create a hostel");
      if (input.wardenId) await this.assertUserInSchool(tx, input.wardenId);
      const h = await tx.hostel.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          type: input.type,
          wardenId: input.wardenId ?? null,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "hostel.create", h.id, { name: input.name, type: input.type });
      return this.hostelDto(tx, h.id);
    });
  }

  async updateHostel(
    p: Principal,
    id: string,
    input: { name?: string; type?: string; wardenId?: string | null; customFields?: Json },
  ): Promise<HostelDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.hostel.findFirst({ where: { id } });
      if (!existing) throw new NotFoundException("Hostel not found");
      await this.assertHostelInScope(tx, p, id);
      if (input.wardenId !== undefined && !this.wide(p)) throw new ForbiddenException("Only an administrator can reassign the warden");
      if (input.wardenId) await this.assertUserInSchool(tx, input.wardenId);
      await tx.hostel.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.wardenId !== undefined ? { wardenId: input.wardenId } : {}),
          ...(input.customFields !== undefined ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
        },
      });
      await this.log(tx, p, "hostel.update", id, { fields: Object.keys(input) });
      return this.hostelDto(tx, id);
    });
  }

  /** Occupancy analytics — warden-scoped to their hostels, else school-wide. */
  async summary(p: Principal): Promise<HostelSummaryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const hostels = await tx.hostel.findMany({ where: this.wide(p) ? {} : { wardenId: p.userId }, select: { id: true } });
      const hostelIds = hostels.map((h) => h.id);
      const rooms = hostelIds.length
        ? await tx.hostelRoom.findMany({ where: { hostelId: { in: hostelIds } }, select: { id: true, capacity: true } })
        : [];
      const beds = rooms.reduce((n, r) => n + r.capacity, 0);
      const occupied = rooms.length
        ? await tx.hostelAllocation.count({ where: { roomId: { in: rooms.map((r) => r.id) }, status: "ACTIVE" } })
        : 0;
      return { hostels: hostels.length, rooms: rooms.length, beds, occupied, vacant: Math.max(0, beds - occupied), occupancyPct: beds ? Math.round((occupied / beds) * 100) : null };
    });
  }

  async listHostels(p: Principal): Promise<HostelDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const hostels = await tx.hostel.findMany({ where: this.wide(p) ? {} : { wardenId: p.userId }, orderBy: { name: "asc" } });
      return Promise.all(hostels.map((h: { id: string }) => this.hostelDto(tx, h.id)));
    });
  }

  // --- rooms ----------------------------------------------------------------

  async createRoom(
    p: Principal,
    hostelId: string,
    input: { roomNumber: string; roomType: string; capacity: number; rentMinor: number; customFields?: Json },
  ): Promise<HostelRoomDto> {
    if (input.capacity < 1) throw new BadRequestException("capacity must be at least 1");
    if (input.rentMinor < 0) throw new BadRequestException("rent cannot be negative");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const hostel = await tx.hostel.findFirst({ where: { id: hostelId }, select: { id: true } });
      if (!hostel) throw new NotFoundException("Hostel not found");
      await this.assertHostelInScope(tx, p, hostelId);
      const dup = await tx.hostelRoom.findFirst({ where: { hostelId, roomNumber: input.roomNumber }, select: { id: true } });
      if (dup) throw new BadRequestException("A room with that number already exists in this hostel");
      const r = await tx.hostelRoom.create({
        data: {
          schoolId: p.schoolId,
          hostelId,
          roomNumber: input.roomNumber,
          roomType: input.roomType,
          capacity: input.capacity,
          rentMinor: input.rentMinor,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "hostel.room.create", r.id, { hostelId, roomNumber: input.roomNumber, rentMinor: input.rentMinor });
      return this.roomDto(tx, r.id);
    });
  }

  async updateRoom(
    p: Principal,
    roomId: string,
    input: { roomType?: string; capacity?: number; rentMinor?: number; customFields?: Json },
  ): Promise<HostelRoomDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.hostelRoom.findFirst({ where: { id: roomId } });
      if (!room) throw new NotFoundException("Room not found");
      await this.assertHostelInScope(tx, p, room.hostelId);
      if (input.capacity !== undefined && input.capacity < 1) throw new BadRequestException("capacity must be at least 1");
      if (input.rentMinor !== undefined && input.rentMinor < 0) throw new BadRequestException("rent cannot be negative");
      await tx.hostelRoom.update({
        where: { id: roomId },
        data: {
          ...(input.roomType !== undefined ? { roomType: input.roomType } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.rentMinor !== undefined ? { rentMinor: input.rentMinor } : {}),
          ...(input.customFields !== undefined ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
        },
      });
      // Audit room/rent CHANGES with before→after so finance can analyse them.
      await this.log(tx, p, "hostel.room.update", roomId, {
        ...(input.rentMinor !== undefined ? { rentBefore: room.rentMinor, rentAfter: input.rentMinor } : {}),
        ...(input.capacity !== undefined ? { capacityBefore: room.capacity, capacityAfter: input.capacity } : {}),
      });
      return this.roomDto(tx, roomId);
    });
  }

  // --- allocations ----------------------------------------------------------

  async allocate(p: Principal, roomId: string, studentId: string): Promise<HostelAllocationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.hostelRoom.findFirst({ where: { id: roomId } });
      if (!room) throw new NotFoundException("Room not found");
      await this.assertHostelInScope(tx, p, room.hostelId);
      await this.assertUserInSchool(tx, studentId);
      // Serialize concurrent allocations to THIS room by locking its row for the
      // rest of the transaction, so the capacity count-then-insert is atomic —
      // two racers can't both read `occupied < capacity` for the last bed and
      // both insert, overflowing the room. (RLS still applies; the row is this
      // tenant's by the scope assertion above.)
      await tx.$executeRaw`SELECT id FROM "hostel_room" WHERE id = ${roomId}::uuid FOR UPDATE`;
      const occupied = await tx.hostelAllocation.count({ where: { roomId, status: "ACTIVE" } });
      if (occupied >= room.capacity) throw new BadRequestException("Room is at full capacity");
      // A student may hold only one ACTIVE bed at a time.
      const existing = await tx.hostelAllocation.findFirst({ where: { studentId, status: "ACTIVE" }, select: { id: true } });
      if (existing) throw new BadRequestException("Student already has an active hostel allocation");
      const a = await tx.hostelAllocation.create({
        data: { schoolId: p.schoolId, roomId, studentId, status: "ACTIVE" },
      });
      await this.log(tx, p, "hostel.allocate", a.id, { roomId, studentId });
      return this.allocationDto(tx, a.id);
    });
  }

  async vacate(p: Principal, allocationId: string): Promise<HostelAllocationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.hostelAllocation.findFirst({ where: { id: allocationId } });
      if (!a) throw new NotFoundException("Allocation not found");
      const vhid = await this.hostelIdForRoom(tx, a.roomId);
      if (vhid) await this.assertHostelInScope(tx, p, vhid);
      if (a.status !== "ACTIVE") throw new BadRequestException("Allocation is not active");
      await tx.hostelAllocation.update({ where: { id: allocationId }, data: { status: "VACATED", vacatedAt: new Date() } });
      await this.log(tx, p, "hostel.vacate", allocationId, { roomId: a.roomId, studentId: a.studentId });
      return this.allocationDto(tx, allocationId);
    });
  }

  async listAllocations(p: Principal, hostelId?: string): Promise<HostelAllocationDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (hostelId) await this.assertHostelInScope(tx, p, hostelId);
      // A warden sees allocations only within their own hostels.
      const roomWhere = hostelId
        ? { hostelId }
        : this.wide(p)
          ? {}
          : { hostel: { wardenId: p.userId } };
      const rooms = await tx.hostelRoom.findMany({ where: roomWhere, select: { id: true } });
      const where = { roomId: { in: rooms.map((r: { id: string }) => r.id) }, status: "ACTIVE" };
      const allocs = await tx.hostelAllocation.findMany({ where, orderBy: { allocatedAt: "desc" } });
      return Promise.all(allocs.map((a: { id: string }) => this.allocationDto(tx, a.id)));
    });
  }

  // --- fee scheduling (bills through the shared Fees invoice tables) ---------

  /** Raise a hostel-rent line item on a draft invoice for every ACTIVE allocation
   *  (optionally just one hostel). If the student already has a DRAFT invoice it is
   *  reused, so hostel rent collects ALONGSIDE academic fees on one invoice. */
  async scheduleFees(
    p: Principal,
    input: { hostelId?: string; dueDate: string; description?: string },
  ): Promise<HostelFeeRunDto> {
    const due = new Date(input.dueDate);
    if (Number.isNaN(due.getTime())) throw new BadRequestException("invalid dueDate");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.hostelId) await this.assertHostelInScope(tx, p, input.hostelId);
      // A warden can bill only their own hostels.
      const feeRoomWhere = input.hostelId
        ? { hostelId: input.hostelId }
        : this.wide(p)
          ? {}
          : { hostel: { wardenId: p.userId } };
      const rooms = await tx.hostelRoom.findMany({ where: feeRoomWhere });
      const rentByRoom = new Map<string, number>(rooms.map((r) => [r.id, r.rentMinor]));
      const roomIds = rooms.map((r) => r.id);
      if (roomIds.length === 0) return { invoicesCreated: 0, totalBilledMinor: 0, studentsBilled: 0 };

      const allocs = await tx.hostelAllocation.findMany({ where: { roomId: { in: roomIds }, status: "ACTIVE" } });
      let invoicesCreated = 0;
      let totalBilledMinor = 0;
      let studentsBilled = 0;

      for (const a of allocs as Array<{ id: string; roomId: string; studentId: string }>) {
        const rent = rentByRoom.get(a.roomId) ?? 0;
        if (rent <= 0) continue;
        // Reuse an existing DRAFT invoice for the student, else open one.
        let invoice = await tx.invoice.findFirst({ where: { studentId: a.studentId, status: "DRAFT" } });
        if (!invoice) {
          invoice = await tx.invoice.create({
            data: {
              schoolId: p.schoolId,
              studentId: a.studentId,
              createdById: p.userId,
              reference: `HOSTEL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              status: "DRAFT",
              totalMinor: 0,
              dueDate: due,
            },
          });
          invoicesCreated++;
        }
        await tx.invoiceLineItem.create({
          data: {
            schoolId: p.schoolId,
            invoiceId: invoice.id,
            description: input.description ?? "Hostel rent",
            amountMinor: rent,
            quantity: 1,
          },
        });
        await tx.invoice.update({ where: { id: invoice.id }, data: { totalMinor: { increment: rent } } });
        totalBilledMinor += rent;
        studentsBilled++;
      }
      await this.log(tx, p, "hostel.fees.schedule", input.hostelId ?? "all", {
        invoicesCreated,
        totalBilledMinor,
        studentsBilled,
      });
      return { invoicesCreated, totalBilledMinor, studentsBilled };
    });
  }

  // --- helpers --------------------------------------------------------------

  private async assertUserInSchool(tx: TenantTx, userId: string): Promise<void> {
    const u = await tx.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!u) throw new NotFoundException("User not found in this school");
  }

  private async roomDto(tx: TenantTx, roomId: string): Promise<HostelRoomDto> {
    const r = await tx.hostelRoom.findFirstOrThrow({ where: { id: roomId } });
    const occupied = await tx.hostelAllocation.count({ where: { roomId, status: "ACTIVE" } });
    return {
      id: r.id,
      hostelId: r.hostelId,
      roomNumber: r.roomNumber,
      roomType: r.roomType,
      capacity: r.capacity,
      rentMinor: r.rentMinor,
      customFields: this.cf(r.customFields),
      occupied,
      available: Math.max(0, r.capacity - occupied),
    };
  }

  private async hostelDto(tx: TenantTx, hostelId: string): Promise<HostelDto> {
    const h = await tx.hostel.findFirstOrThrow({ where: { id: hostelId } });
    const rooms = await tx.hostelRoom.findMany({ where: { hostelId }, orderBy: { roomNumber: "asc" } });
    const roomDtos = await Promise.all(rooms.map((r: { id: string }) => this.roomDto(tx, r.id)));
    const warden = h.wardenId ? await tx.user.findFirst({ where: { id: h.wardenId }, select: { name: true } }) : null;
    const totalBeds = roomDtos.reduce((s, r) => s + r.capacity, 0);
    const occupiedBeds = roomDtos.reduce((s, r) => s + r.occupied, 0);
    return {
      id: h.id,
      name: h.name,
      type: h.type,
      wardenId: h.wardenId,
      wardenName: warden?.name ?? null,
      customFields: this.cf(h.customFields),
      rooms: roomDtos,
      totalBeds,
      occupiedBeds,
      availableBeds: Math.max(0, totalBeds - occupiedBeds),
      createdAt: h.createdAt,
    };
  }

  private async allocationDto(tx: TenantTx, id: string): Promise<HostelAllocationDto> {
    const a = await tx.hostelAllocation.findFirstOrThrow({ where: { id } });
    const room = await tx.hostelRoom.findFirstOrThrow({ where: { id: a.roomId } });
    const hostel = await tx.hostel.findFirstOrThrow({ where: { id: room.hostelId }, select: { name: true } });
    const student = await tx.user.findFirst({ where: { id: a.studentId }, select: { name: true } });
    return {
      id: a.id,
      roomId: a.roomId,
      hostelName: hostel.name,
      roomNumber: room.roomNumber,
      studentId: a.studentId,
      studentName: student?.name ?? "",
      status: a.status,
      rentMinor: room.rentMinor,
      allocatedAt: a.allocatedAt,
      vacatedAt: a.vacatedAt,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "hostel", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
