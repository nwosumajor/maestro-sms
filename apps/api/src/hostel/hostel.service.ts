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

import { ConflictException, BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import type {
  HostelAllocationDto,
  HostelAttendanceDto,
  HostelDto,
  HostelExeatDto,
  HostelFeeRunDto,
  HostelIncidentDto,
  HostelRoomDto,
  HostelSummaryDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { NotificationService } from "../notifications/notification.service";

type Json = Record<string, string>;

/** A hostel's gender policy must admit the student. MIXED admits anyone; a BOYS /
 *  GIRLS house admits only that gender. An UNSET student gender can't be verified,
 *  so a gendered house rejects it (fail-closed) — set the profile gender first. */
function genderAdmits(hostelType: string, studentGender: string | null): boolean {
  const t = (hostelType ?? "MIXED").toUpperCase();
  if (t === "MIXED") return true;
  const g = (studentGender ?? "").trim().toUpperCase();
  if (t === "BOYS") return g === "M" || g === "MALE" || g === "BOY";
  if (t === "GIRLS") return g === "F" || g === "FEMALE" || g === "GIRL";
  return true; // unknown hostel type → don't block
}

@Injectable()
export class HostelService {
  private readonly logger = new Logger("Hostel");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
    private readonly notifications: NotificationService,
  ) {
    // Maker-checker reactor: when an admin APPROVES a FEE_SCHEDULE request that a
    // (head-)warden raised, post the fee run in the SAME tenant tx as the
    // transition (atomic). The initiator is the recorded actor.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "FEE_SCHEDULE" || req.state !== "APPROVED") return;
      const pl = req.payload as { module?: string; hostelId?: string | null; dueDate?: string; description?: string | null; scopeWardenId?: string | null } | null;
      if (pl?.module !== "hostel" || !pl.dueDate) return;
      await this.postFeeRun(tx, req.schoolId, req.initiatorId, {
        hostelId: pl.hostelId ?? undefined,
        due: new Date(pl.dueDate),
        description: pl.description ?? undefined,
        scopeWardenId: pl.scopeWardenId ?? null,
      });
    });
  }

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
  /** Module-wide scoping: admins AND the head warden see/manage EVERY hostel.
   *  junior_admin (the operational records tier) holds hostel.read and is
   *  included here for READ visibility across all hostels — it never gains write
   *  power, since every mutating endpoint is @RequirePermission(hostel.manage),
   *  which junior_admin does not hold. Structural acts (create/delete hostel,
   *  reassign warden) stay wide()-only, and money (fee runs) is maker-checker for
   *  everyone below wide(). */
  private moduleWide(p: Principal): boolean {
    return this.wide(p) || p.roles.includes("head_warden") || p.roles.includes("junior_admin");
  }
  /** A warden may only act on their own hostel (404-not-403 for anything else). */
  private async assertHostelInScope(tx: TenantTx, p: Principal, hostelId: string): Promise<void> {
    if (this.moduleWide(p)) return;
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

  /** Delete an EMPTY hostel (duplicate/typo cleanup). Admin-only — a warden
   *  manages their hostel but cannot remove it. 409 while rooms exist. */
  async deleteHostel(p: Principal, id: string): Promise<{ ok: boolean }> {
    if (!this.wide(p)) throw new ForbiddenException("Only an administrator can delete a hostel");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const h = await tx.hostel.findFirst({ where: { id } });
      if (!h) throw new NotFoundException("Hostel not found");
      const rooms = await tx.hostelRoom.count({ where: { hostelId: id } });
      if (rooms > 0) {
        throw new ConflictException(
          `"${h.name}" still has ${rooms} room${rooms === 1 ? "" : "s"} — delete its rooms first (each must have no allocation history)`,
        );
      }
      await tx.hostel.delete({ where: { id } });
      await this.log(tx, p, "hostel.delete", id, { name: h.name });
      return { ok: true };
    });
  }

  /** Delete a room with NO allocation history (409 otherwise — past allocations
   *  are records the school keeps). Warden-scoped like the other room actions. */
  async deleteRoom(p: Principal, roomId: string): Promise<{ ok: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.hostelRoom.findFirst({ where: { id: roomId } });
      if (!room) throw new NotFoundException("Room not found");
      await this.assertHostelInScope(tx, p, room.hostelId);
      const allocations = await tx.hostelAllocation.count({ where: { roomId } });
      if (allocations > 0) {
        throw new ConflictException(
          `Room ${room.roomNumber} has ${allocations} allocation record${allocations === 1 ? "" : "s"} (including past ones) — rooms with allocation history can't be deleted; rename it instead`,
        );
      }
      await tx.hostelRoom.delete({ where: { id: roomId } });
      await this.log(tx, p, "hostel.room.delete", roomId, { roomNumber: room.roomNumber, hostelId: room.hostelId });
      return { ok: true };
    });
  }

  /** Occupancy analytics — warden-scoped to their hostels, else school-wide. */
  async summary(p: Principal): Promise<HostelSummaryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const hostels = await tx.hostel.findMany({ where: this.moduleWide(p) ? {} : { wardenId: p.userId }, select: { id: true } });
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
      const hostels = await tx.hostel.findMany({ where: this.moduleWide(p) ? {} : { wardenId: p.userId }, orderBy: { name: "asc" } });
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
    input: { roomNumber?: string; roomType?: string; capacity?: number; rentMinor?: number; customFields?: Json },
  ): Promise<HostelRoomDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.hostelRoom.findFirst({ where: { id: roomId } });
      if (!room) throw new NotFoundException("Room not found");
      await this.assertHostelInScope(tx, p, room.hostelId);
      if (input.capacity !== undefined && input.capacity < 1) throw new BadRequestException("capacity must be at least 1");
      if (input.rentMinor !== undefined && input.rentMinor < 0) throw new BadRequestException("rent cannot be negative");
      // A room number must stay unique within its hostel.
      if (input.roomNumber !== undefined && input.roomNumber !== room.roomNumber) {
        const clash = await tx.hostelRoom.findFirst({
          where: { hostelId: room.hostelId, roomNumber: input.roomNumber, id: { not: roomId } },
          select: { id: true },
        });
        if (clash) throw new ConflictException(`Room ${input.roomNumber} already exists in this hostel`);
      }
      // Shrinking capacity below the current occupancy would strand allocations.
      if (input.capacity !== undefined) {
        const occupied = await tx.hostelAllocation.count({ where: { roomId, status: "ACTIVE" } });
        if (input.capacity < occupied) {
          throw new ConflictException(`Capacity can't be below the ${occupied} student(s) currently allocated`);
        }
      }
      await tx.hostelRoom.update({
        where: { id: roomId },
        data: {
          ...(input.roomNumber !== undefined ? { roomNumber: input.roomNumber } : {}),
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
      // GENDER MATCH: a BOYS/GIRLS hostel must not admit the wrong gender. The
      // student's gender comes from the SIS profile; an unset gender fails-closed
      // against a gendered house (set the profile first). MIXED admits anyone.
      const hostel = await tx.hostel.findFirst({ where: { id: room.hostelId }, select: { type: true, name: true } });
      if (hostel && (hostel.type ?? "MIXED").toUpperCase() !== "MIXED") {
        const profile = await tx.studentProfile.findFirst({ where: { studentId }, select: { gender: true } });
        if (!genderAdmits(hostel.type, profile?.gender ?? null)) {
          throw new BadRequestException(
            `${hostel.name} is a ${hostel.type.toLowerCase()} hostel and can't admit this student` +
              `${profile?.gender ? "" : " (no gender on the student's profile — set it first)"}.`,
          );
        }
      }
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
        : this.moduleWide(p)
          ? {}
          : { hostel: { wardenId: p.userId } };
      const rooms = await tx.hostelRoom.findMany({ where: roomWhere, select: { id: true } });
      const where = { roomId: { in: rooms.map((r: { id: string }) => r.id) }, status: "ACTIVE" };
      const allocs = await tx.hostelAllocation.findMany({ where, orderBy: { allocatedAt: "desc" } });
      if (allocs.length === 0) return [];
      // Batch room/hostel/student lookups (was 4 queries per allocation via
      // allocationDto — hundreds for a full dorm).
      const roomRows = await tx.hostelRoom.findMany({
        where: { id: { in: [...new Set(allocs.map((a) => a.roomId))] } },
        select: { id: true, roomNumber: true, rentMinor: true, hostelId: true },
      });
      const roomById = new Map(roomRows.map((r) => [r.id, r]));
      const hostelRows = await tx.hostel.findMany({
        where: { id: { in: [...new Set(roomRows.map((r) => r.hostelId))] } },
        select: { id: true, name: true },
      });
      const hostelName = new Map(hostelRows.map((h) => [h.id, h.name]));
      const students = await tx.user.findMany({
        where: { id: { in: [...new Set(allocs.map((a) => a.studentId))] } },
        select: { id: true, name: true },
      });
      const studentName = new Map(students.map((u) => [u.id, u.name]));
      return allocs.map((a) => {
        const room = roomById.get(a.roomId);
        return mapAllocationDto(
          a,
          { roomNumber: room?.roomNumber ?? "", rentMinor: room?.rentMinor ?? 0 },
          room ? (hostelName.get(room.hostelId) ?? "") : "",
          studentName.get(a.studentId) ?? "",
        );
      });
    });
  }

  // --- room transfer --------------------------------------------------------

  /** Move a student to another room in ONE transaction: vacate the current
   *  active allocation and allocate the new room (gender + capacity re-checked).
   *  The reason is audited; history is retained (the old allocation stays VACATED). */
  async transferAllocation(
    p: Principal,
    studentId: string,
    toRoomId: string,
    reason?: string,
  ): Promise<HostelAllocationDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const current = await tx.hostelAllocation.findFirst({ where: { studentId, status: "ACTIVE" } });
      if (!current) throw new BadRequestException("Student has no active hostel allocation to transfer");
      const fromRoom = await tx.hostelRoom.findFirst({ where: { id: current.roomId }, select: { hostelId: true } });
      if (fromRoom) await this.assertHostelInScope(tx, p, fromRoom.hostelId);
      const toRoom = await tx.hostelRoom.findFirst({ where: { id: toRoomId } });
      if (!toRoom) throw new NotFoundException("Target room not found");
      if (toRoomId === current.roomId) throw new BadRequestException("Student is already in that room");
      await this.assertHostelInScope(tx, p, toRoom.hostelId);
      // Gender match on the destination hostel.
      const toHostel = await tx.hostel.findFirst({ where: { id: toRoom.hostelId }, select: { type: true, name: true } });
      if (toHostel && (toHostel.type ?? "MIXED").toUpperCase() !== "MIXED") {
        const profile = await tx.studentProfile.findFirst({ where: { studentId }, select: { gender: true } });
        if (!genderAdmits(toHostel.type, profile?.gender ?? null)) {
          throw new BadRequestException(`${toHostel.name} is a ${toHostel.type.toLowerCase()} hostel and can't admit this student.`);
        }
      }
      // Capacity claim on the destination (row-lock, mirrors allocate()).
      await tx.$executeRaw`SELECT id FROM "hostel_room" WHERE id = ${toRoomId}::uuid FOR UPDATE`;
      const occupied = await tx.hostelAllocation.count({ where: { roomId: toRoomId, status: "ACTIVE" } });
      if (occupied >= toRoom.capacity) throw new BadRequestException("Target room is at full capacity");
      await tx.hostelAllocation.update({ where: { id: current.id }, data: { status: "VACATED", vacatedAt: new Date() } });
      const a = await tx.hostelAllocation.create({ data: { schoolId: p.schoolId, roomId: toRoomId, studentId, status: "ACTIVE" } });
      await this.log(tx, p, "hostel.transfer", a.id, { studentId, fromRoomId: current.roomId, toRoomId, reason: reason ?? null });
      return this.allocationDto(tx, a.id);
    });
  }

  // --- roll-call / boarding attendance --------------------------------------

  /** Record nightly roll-call for a hostel on a date (upsert one row per student).
   *  Only ACTIVE-allocated students of the hostel may be marked. */
  async rollCall(
    p: Principal,
    hostelId: string,
    date: string,
    records: { studentId: string; status: string; note?: string | null }[],
  ): Promise<{ marked: number }> {
    const day = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException("Invalid date");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertHostelInScope(tx, p, hostelId);
      // The set of students currently boarding in this hostel.
      const rooms = await tx.hostelRoom.findMany({ where: { hostelId }, select: { id: true } });
      const roomIds = rooms.map((r) => r.id);
      const boarders = new Set(
        (await tx.hostelAllocation.findMany({ where: { roomId: { in: roomIds }, status: "ACTIVE" }, select: { studentId: true } })).map(
          (a) => a.studentId,
        ),
      );
      // Roll-call for a date is a FULL replacement, so write it as two set-based
      // statements instead of one upsert per boarder — a large house (the API
      // accepts up to 1000) would otherwise fire 1000 round-trips inside one
      // interactive transaction and risk its time cap.
      const wanted = records.filter((rec) => boarders.has(rec.studentId)); // only current boarders
      await tx.hostelAttendance.deleteMany({ where: { hostelId, date: day } });
      if (wanted.length > 0) {
        await tx.hostelAttendance.createMany({
          data: wanted.map((rec) => ({
            schoolId: p.schoolId,
            hostelId,
            studentId: rec.studentId,
            date: day,
            status: rec.status,
            note: rec.note ?? null,
            takenById: p.userId,
          })),
        });
      }
      const marked = wanted.length;
      await this.log(tx, p, "hostel.rollcall", hostelId, { date, marked });
      return { marked };
    });
  }

  async listAttendance(p: Principal, hostelId: string, date: string): Promise<HostelAttendanceDto[]> {
    const day = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException("Invalid date");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertHostelInScope(tx, p, hostelId);
      const rows = await tx.hostelAttendance.findMany({ where: { hostelId, date: day }, orderBy: { createdAt: "asc" } });
      const names = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.studentId))] } }, select: { id: true, name: true } });
      const nameById = new Map(names.map((u) => [u.id, u.name]));
      return rows.map((r) => ({
        id: r.id,
        hostelId: r.hostelId,
        studentId: r.studentId,
        studentName: nameById.get(r.studentId) ?? "",
        date: r.date,
        status: r.status,
        note: r.note,
        takenById: r.takenById,
      }));
    });
  }

  // --- exeat / gate-pass (maker-checker; guardians notified) -----------------

  /** Raise an exeat request for a boarder (REQUESTED). Moves no one. */
  async requestExeat(
    p: Principal,
    input: { studentId: string; reason: string; destination?: string | null; departAt: string; expectedReturnAt: string },
  ): Promise<HostelExeatDto> {
    const departAt = new Date(input.departAt);
    const expectedReturnAt = new Date(input.expectedReturnAt);
    if (Number.isNaN(departAt.getTime()) || Number.isNaN(expectedReturnAt.getTime())) throw new BadRequestException("Invalid dates");
    if (expectedReturnAt <= departAt) throw new BadRequestException("Expected return must be after departure");
    if (!input.reason?.trim()) throw new BadRequestException("A reason is required");
    const dto = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const alloc = await tx.hostelAllocation.findFirst({ where: { studentId: input.studentId, status: "ACTIVE" } });
      if (!alloc) throw new BadRequestException("Only a current boarder can be granted an exeat");
      const room = await tx.hostelRoom.findFirst({ where: { id: alloc.roomId }, select: { hostelId: true } });
      const hostelId = room?.hostelId ?? "";
      await this.assertHostelInScope(tx, p, hostelId);
      const row = await tx.hostelExeat.create({
        data: {
          schoolId: p.schoolId,
          hostelId,
          studentId: input.studentId,
          reason: input.reason.trim(),
          destination: input.destination?.trim() || null,
          departAt,
          expectedReturnAt,
          status: "REQUESTED",
          requestedById: p.userId,
        },
      });
      await this.log(tx, p, "hostel.exeat.request", row.id, { studentId: input.studentId });
      return this.exeatDto(tx, row.id);
    });
    return dto;
  }

  /** Approve/reject an exeat (a DIFFERENT person than the requester — SoD). */
  async decideExeat(p: Principal, id: string, approve: boolean, note?: string): Promise<HostelExeatDto> {
    const { dto, studentId } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.hostelExeat.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Exeat not found");
      await this.assertHostelInScope(tx, p, row.hostelId);
      if (row.status !== "REQUESTED") throw new BadRequestException("This exeat has already been decided");
      if (row.requestedById === p.userId) throw new ForbiddenException("An exeat must be decided by a different person");
      const updated = await tx.hostelExeat.update({
        where: { id },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedById: p.userId, decidedAt: new Date(), note: note?.trim() || null },
      });
      await this.log(tx, p, approve ? "hostel.exeat.approve" : "hostel.exeat.reject", id, { studentId: row.studentId });
      return { dto: await this.exeatDto(tx, updated.id), studentId: row.studentId };
    });
    if (approve) {
      await this.notifyGuardians(p, studentId, "Exeat approved", `An exeat has been approved for your child: ${dto.reason}. Expected back ${dto.expectedReturnAt.toISOString().slice(0, 16).replace("T", " ")}.`);
    }
    return dto;
  }

  /** Mark a boarder as departed (gate check-out) or returned (check-in). */
  async setExeatMovement(p: Principal, id: string, movement: "DEPARTED" | "RETURNED"): Promise<HostelExeatDto> {
    const { dto, studentId } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.hostelExeat.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Exeat not found");
      await this.assertHostelInScope(tx, p, row.hostelId);
      if (movement === "DEPARTED" && row.status !== "APPROVED") throw new BadRequestException("Only an approved exeat can depart");
      if (movement === "RETURNED" && row.status !== "DEPARTED") throw new BadRequestException("Only a departed boarder can be marked returned");
      const updated = await tx.hostelExeat.update({
        where: { id },
        data: { status: movement, ...(movement === "RETURNED" ? { actualReturnAt: new Date() } : {}) },
      });
      await this.log(tx, p, `hostel.exeat.${movement.toLowerCase()}`, id, { studentId: row.studentId });
      return { dto: await this.exeatDto(tx, updated.id), studentId: row.studentId };
    });
    await this.notifyGuardians(
      p,
      studentId,
      movement === "DEPARTED" ? "Your child left on exeat" : "Your child is back from exeat",
      movement === "DEPARTED" ? "Your child has checked out of the hostel on their approved exeat." : "Your child has returned to the hostel and checked in.",
    );
    return dto;
  }

  async listExeats(p: Principal, opts: { hostelId?: string; status?: string } = {}): Promise<HostelExeatDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (opts.hostelId) await this.assertHostelInScope(tx, p, opts.hostelId);
      const where: Record<string, unknown> = {};
      if (opts.hostelId) where.hostelId = opts.hostelId;
      else if (!this.moduleWide(p)) {
        const mine = await tx.hostel.findMany({ where: { wardenId: p.userId }, select: { id: true } });
        where.hostelId = { in: mine.map((h) => h.id) };
      }
      if (opts.status) where.status = opts.status;
      const rows = await tx.hostelExeat.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 });
      return this.mapExeats(tx, rows);
    });
  }

  // --- maintenance / incident log -------------------------------------------

  async reportIncident(
    p: Principal,
    input: { hostelId: string; roomId?: string | null; category: string; title: string; description?: string | null },
  ): Promise<HostelIncidentDto> {
    if (!input.title?.trim()) throw new BadRequestException("A title is required");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertHostelInScope(tx, p, input.hostelId);
      if (input.roomId) {
        const room = await tx.hostelRoom.findFirst({ where: { id: input.roomId, hostelId: input.hostelId }, select: { id: true } });
        if (!room) throw new NotFoundException("Room not found in this hostel");
      }
      const row = await tx.hostelIncident.create({
        data: {
          schoolId: p.schoolId,
          hostelId: input.hostelId,
          roomId: input.roomId ?? null,
          category: input.category,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          status: "OPEN",
          reportedById: p.userId,
        },
      });
      await this.log(tx, p, "hostel.incident.report", row.id, { hostelId: input.hostelId, category: input.category });
      return this.incidentDto(tx, row.id);
    });
  }

  async updateIncident(
    p: Principal,
    id: string,
    input: { status?: string; resolutionNote?: string | null },
  ): Promise<HostelIncidentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.hostelIncident.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Incident not found");
      await this.assertHostelInScope(tx, p, row.hostelId);
      const resolving = input.status === "RESOLVED" && row.status !== "RESOLVED";
      const updated = await tx.hostelIncident.update({
        where: { id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.resolutionNote !== undefined ? { resolutionNote: input.resolutionNote?.trim() || null } : {}),
          ...(resolving ? { resolvedById: p.userId, resolvedAt: new Date() } : {}),
        },
      });
      await this.log(tx, p, "hostel.incident.update", id, { status: updated.status });
      return this.incidentDto(tx, id);
    });
  }

  async listIncidents(p: Principal, opts: { hostelId?: string; status?: string } = {}): Promise<HostelIncidentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (opts.hostelId) await this.assertHostelInScope(tx, p, opts.hostelId);
      const where: Record<string, unknown> = {};
      if (opts.hostelId) where.hostelId = opts.hostelId;
      else if (!this.moduleWide(p)) {
        const mine = await tx.hostel.findMany({ where: { wardenId: p.userId }, select: { id: true } });
        where.hostelId = { in: mine.map((h) => h.id) };
      }
      if (opts.status) where.status = opts.status;
      const rows = await tx.hostelIncident.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 });
      return this.mapIncidents(tx, rows);
    });
  }

  // --- fee scheduling (bills through the shared Fees invoice tables) ---------

  /** Raise a hostel-rent line item on a draft invoice for every ACTIVE allocation
   *  (optionally just one hostel). If the student already has a DRAFT invoice it is
   *  reused, so hostel rent collects ALONGSIDE academic fees on one invoice. */
  async scheduleFees(
    p: Principal,
    input: { hostelId?: string; dueDate: string; description?: string },
  ): Promise<HostelFeeRunDto | { pendingApproval: true; requestId: string }> {
    const due = new Date(input.dueDate);
    if (Number.isNaN(due.getTime())) throw new BadRequestException("invalid dueDate");
    // MAKER-CHECKER: fee runs MOVE MONEY (they post rent onto student invoices),
    // so a (head-)warden's run does NOT post directly — it becomes a FEE_SCHEDULE
    // workflow request that a workflow.review holder (school_admin/principal — a
    // DIFFERENT person, engine-enforced) must approve; the approved run posts
    // in-tx via the finalized hook. Admins (wide) still post immediately.
    if (!this.wide(p)) {
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        if (input.hostelId) await this.assertHostelInScope(tx, p, input.hostelId);
      });
      // Snapshot the initiator's billing scope so approval can't widen it.
      const scopeWardenId = p.roles.includes("head_warden") ? null : p.userId;
      const req = (await this.workflow.createRequest(p, {
        type: "FEE_SCHEDULE",
        title: `Hostel fee run (${input.hostelId ? "one hostel" : "all in scope"}) due ${input.dueDate.slice(0, 10)}`,
        payload: { module: "hostel", hostelId: input.hostelId ?? null, dueDate: input.dueDate, description: input.description ?? null, scopeWardenId },
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true, requestId: req.id };
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.hostelId) await this.assertHostelInScope(tx, p, input.hostelId);
      return this.postFeeRun(tx, p.schoolId, p.userId, { hostelId: input.hostelId, due, description: input.description, scopeWardenId: null });
    });
  }

  /** Post a hostel fee run (rent -> invoice line items). Runs either directly
   *  (admin) or from the FEE_SCHEDULE approval hook, always inside a tenant tx. */
  private async postFeeRun(
    tx: TenantTx,
    schoolId: string,
    actorId: string,
    input: { hostelId?: string; due: Date; description?: string; scopeWardenId: string | null },
  ): Promise<HostelFeeRunDto> {
    {
      const due = input.due;
      const feeRoomWhere = input.hostelId
        ? { hostelId: input.hostelId }
        : input.scopeWardenId
          ? { hostel: { wardenId: input.scopeWardenId } }
          : {};
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
              schoolId,
              studentId: a.studentId,
              createdById: actorId,
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
            schoolId,
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
      await this.audit.record(
        { actorId, action: "hostel.fees.schedule", entity: "hostel", entityId: input.hostelId ?? "all", schoolId, metadata: { invoicesCreated, totalBilledMinor, studentsBilled } },
        tx,
      );
      return { invoicesCreated, totalBilledMinor, studentsBilled };
    }
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
    return mapAllocationDto(a, room, hostel.name, student?.name ?? "");
  }

  private async exeatDto(tx: TenantTx, id: string): Promise<HostelExeatDto> {
    const row = await tx.hostelExeat.findFirstOrThrow({ where: { id } });
    return (await this.mapExeats(tx, [row]))[0];
  }

  private async mapExeats(tx: TenantTx, rows: Array<Record<string, unknown>>): Promise<HostelExeatDto[]> {
    if (rows.length === 0) return [];
    const r = rows as unknown as Array<{ id: string; hostelId: string; studentId: string; reason: string; destination: string | null; departAt: Date; expectedReturnAt: Date; actualReturnAt: Date | null; status: string; requestedById: string; decidedById: string | null; decidedAt: Date | null; note: string | null; createdAt: Date }>;
    const hostels = await tx.hostel.findMany({ where: { id: { in: [...new Set(r.map((x) => x.hostelId))] } }, select: { id: true, name: true } });
    const hName = new Map(hostels.map((h) => [h.id, h.name]));
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(r.map((x) => x.studentId))] } }, select: { id: true, name: true } });
    const sName = new Map(users.map((u) => [u.id, u.name]));
    return r.map((x) => ({
      id: x.id,
      hostelId: x.hostelId,
      hostelName: hName.get(x.hostelId) ?? "",
      studentId: x.studentId,
      studentName: sName.get(x.studentId) ?? "",
      reason: x.reason,
      destination: x.destination,
      departAt: x.departAt,
      expectedReturnAt: x.expectedReturnAt,
      actualReturnAt: x.actualReturnAt,
      status: x.status,
      requestedById: x.requestedById,
      decidedById: x.decidedById,
      decidedAt: x.decidedAt,
      note: x.note,
      createdAt: x.createdAt,
    }));
  }

  private async incidentDto(tx: TenantTx, id: string): Promise<HostelIncidentDto> {
    const row = await tx.hostelIncident.findFirstOrThrow({ where: { id } });
    return (await this.mapIncidents(tx, [row]))[0];
  }

  private async mapIncidents(tx: TenantTx, rows: Array<Record<string, unknown>>): Promise<HostelIncidentDto[]> {
    if (rows.length === 0) return [];
    const r = rows as unknown as Array<{ id: string; hostelId: string; roomId: string | null; category: string; title: string; description: string | null; status: string; reportedById: string; resolvedById: string | null; resolvedAt: Date | null; resolutionNote: string | null; createdAt: Date }>;
    const hostels = await tx.hostel.findMany({ where: { id: { in: [...new Set(r.map((x) => x.hostelId))] } }, select: { id: true, name: true } });
    const hName = new Map(hostels.map((h) => [h.id, h.name]));
    const roomIds = [...new Set(r.map((x) => x.roomId).filter((x): x is string => !!x))];
    const rooms = roomIds.length ? await tx.hostelRoom.findMany({ where: { id: { in: roomIds } }, select: { id: true, roomNumber: true } }) : [];
    const rNum = new Map(rooms.map((x) => [x.id, x.roomNumber]));
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(r.map((x) => x.reportedById))] } }, select: { id: true, name: true } });
    const uName = new Map(users.map((u) => [u.id, u.name]));
    return r.map((x) => ({
      id: x.id,
      hostelId: x.hostelId,
      hostelName: hName.get(x.hostelId) ?? "",
      roomId: x.roomId,
      roomNumber: x.roomId ? (rNum.get(x.roomId) ?? null) : null,
      category: x.category,
      title: x.title,
      description: x.description,
      status: x.status,
      reportedById: x.reportedById,
      reportedByName: uName.get(x.reportedById) ?? null,
      resolvedById: x.resolvedById,
      resolvedAt: x.resolvedAt,
      resolutionNote: x.resolutionNote,
      createdAt: x.createdAt,
    }));
  }

  /** Best-effort guardian notification (never blocks the caller's action). */
  private async notifyGuardians(p: Principal, studentId: string, title: string, body: string): Promise<void> {
    try {
      const links = await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      for (const l of links as { parentId: string }[]) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: l.parentId,
          type: "HOSTEL",
          title,
          body,
          data: { studentId },
          channels: ["EMAIL"],
        });
      }
    } catch (err) {
      this.logger.error(`Hostel guardian notification failed for ${studentId}: ${String(err)}`);
    }
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "hostel", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

/** Pure allocation-row → DTO. Room/hostel/student are supplied by the caller —
 *  fetched once for a single allocation (allocationDto) or batched across a page
 *  (listAllocations) — so listing never fans into a per-row query storm. */
function mapAllocationDto(
  a: { id: string; roomId: string; studentId: string; status: string; allocatedAt: Date; vacatedAt: Date | null },
  room: { roomNumber: string; rentMinor: number },
  hostelName: string,
  studentName: string,
): HostelAllocationDto {
  return {
    id: a.id,
    roomId: a.roomId,
    hostelName,
    roomNumber: room.roomNumber,
    studentId: a.studentId,
    studentName,
    status: a.status,
    rentMinor: room.rentMinor,
    allocatedAt: a.allocatedAt,
    vacatedAt: a.vacatedAt,
  };
}
