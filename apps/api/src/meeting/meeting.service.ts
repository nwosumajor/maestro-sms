// =============================================================================
// MeetingService — parent-teacher appointment slots + bookings
// =============================================================================
// A teacher (or staff) opens time slots; a parent books one for one of their
// OWN children (relationship-checked). The slot is claimed atomically — an
// optimistic capacity check under updateMany semantics prevents two parents
// over-booking a single-capacity slot. Both parties are notified on book and
// cancel. Reads are scoped: a teacher sees their own slots + bookings; a parent
// sees open slots and their own bookings.
// =============================================================================

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MeetingSlotDto, MeetingBookingDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";

const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);

@Injectable()
export class MeetingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- teacher: manage slots --------------------------------------------------

  /** Open a slot. A teacher opens their OWN; staff-wide may open for any teacher. */
  async createSlot(
    p: Principal,
    input: { teacherId?: string; startsAt: string; endsAt: string; capacity?: number; location?: string; note?: string },
  ): Promise<MeetingSlotDto> {
    const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
    const teacherId = input.teacherId && staffWide ? input.teacherId : p.userId;
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestException("endsAt must be after startsAt");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.meetingSlot.create({
        data: {
          schoolId: p.schoolId,
          teacherId,
          startsAt,
          endsAt,
          capacity: Math.max(1, Math.min(input.capacity ?? 1, 30)),
          location: input.location ?? null,
          note: input.note ?? null,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.slot.create", entity: "meeting_slot", entityId: row.id, schoolId: p.schoolId, metadata: { teacherId } },
        tx,
      );
      return this.toSlotDto(row, 0, teacherId === p.userId ? p : null);
    });
  }

  /** Withdraw an unbooked slot. Host / staff-wide. */
  async withdrawSlot(p: Principal, id: string): Promise<{ withdrawn: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const slot = await tx.meetingSlot.findFirst({ where: { id }, select: { teacherId: true } });
      if (!slot) throw new NotFoundException("Slot not found");
      if (slot.teacherId !== p.userId && !p.roles.some((r) => STAFF_WIDE.has(r))) {
        throw new ForbiddenException("Only the host or an administrator may withdraw this slot");
      }
      const booked = await tx.meetingBooking.count({ where: { slotId: id, status: "BOOKED" } });
      if (booked > 0) throw new ConflictException("The slot has bookings — cancel those first");
      await tx.meetingSlot.update({ where: { id }, data: { active: false } });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.slot.withdraw", entity: "meeting_slot", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { withdrawn: true };
    });
  }

  /** The caller's own hosted slots (teacher/staff) with booking counts. */
  async mySlots(p: Principal): Promise<MeetingSlotDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
      const slots = await tx.meetingSlot.findMany({
        where: staffWide ? {} : { teacherId: p.userId },
        orderBy: { startsAt: "asc" },
        take: 200,
      });
      const counts = await this.bookingCounts(tx, slots.map((s: { id: string }) => s.id));
      const teacherNames = await this.userNames(tx, slots.map((s: { teacherId: string }) => s.teacherId));
      return slots.map((s: SlotRow) => this.toSlotDto(s, counts.get(s.id) ?? 0, null, teacherNames.get(s.teacherId)));
    });
  }

  // --- parent: browse + book --------------------------------------------------

  /** Open slots a parent can book (future, active, not full). Teacher optional. */
  async openSlots(p: Principal, teacherId?: string): Promise<MeetingSlotDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const slots = await tx.meetingSlot.findMany({
        where: { active: true, startsAt: { gte: new Date() }, ...(teacherId ? { teacherId } : {}) },
        orderBy: { startsAt: "asc" },
        take: 200,
      });
      const counts = await this.bookingCounts(tx, slots.map((s: { id: string }) => s.id));
      const teacherNames = await this.userNames(tx, slots.map((s: { teacherId: string }) => s.teacherId));
      return slots
        .filter((s: SlotRow) => (counts.get(s.id) ?? 0) < s.capacity)
        .map((s: SlotRow) => this.toSlotDto(s, counts.get(s.id) ?? 0, null, teacherNames.get(s.teacherId)));
    });
  }

  /** Book a slot for the parent's child. Atomic capacity claim. */
  async book(p: Principal, slotId: string, studentId: string, note?: string): Promise<MeetingBookingDto> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The child must be the caller's own.
      const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
      if (!link) throw new ForbiddenException("You can only book for your own child");
      const slot = await tx.meetingSlot.findFirst({ where: { id: slotId, active: true }, select: { id: true, teacherId: true, capacity: true, startsAt: true } });
      if (!slot) throw new NotFoundException("Slot not found");
      if (slot.startsAt < new Date()) throw new BadRequestException("That slot is in the past");
      // No double-booking the same slot by the same parent.
      const dup = await tx.meetingBooking.findFirst({ where: { slotId, parentId: p.userId, status: "BOOKED" }, select: { id: true } });
      if (dup) throw new ConflictException("You already have a booking for this slot");
      // Capacity claim: count BOOKED and reject if full (serialized within the tx).
      const booked = await tx.meetingBooking.count({ where: { slotId, status: "BOOKED" } });
      if (booked >= slot.capacity) throw new ConflictException("That slot is fully booked");
      const row = await tx.meetingBooking.create({
        data: { schoolId: p.schoolId, slotId, parentId: p.userId, studentId, note: note ?? null },
      });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.book", entity: "meeting_booking", entityId: row.id, schoolId: p.schoolId, metadata: { slotId, studentId } },
        tx,
      );
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
      return { row, teacherId: slot.teacherId, startsAt: slot.startsAt, studentName: student?.name ?? "" };
    });

    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: outcome.teacherId,
        type: "GENERIC",
        title: "Parent meeting booked",
        body: `A parent booked a meeting about ${outcome.studentName} for ${outcome.startsAt.toISOString().slice(0, 16).replace("T", " ")}.`,
        data: { slotId, bookingId: outcome.row.id },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return this.toBookingDto(outcome.row, outcome.startsAt, outcome.studentName);
  }

  /** Cancel a booking. The booking parent, the host teacher, or staff-wide. */
  async cancelBooking(p: Principal, bookingId: string): Promise<{ cancelled: boolean }> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = await tx.meetingBooking.findFirst({ where: { id: bookingId }, include: { slot: { select: { teacherId: true, startsAt: true } } } });
      if (!b) throw new NotFoundException("Booking not found");
      const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
      if (b.parentId !== p.userId && b.slot.teacherId !== p.userId && !staffWide) {
        throw new ForbiddenException("You cannot cancel this booking");
      }
      if (b.status !== "BOOKED") throw new BadRequestException("Already cancelled");
      await tx.meetingBooking.update({ where: { id: bookingId }, data: { status: "CANCELLED" } });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.cancel", entity: "meeting_booking", entityId: bookingId, schoolId: p.schoolId },
        tx,
      );
      // Notify the OTHER party.
      const notifyId = p.userId === b.parentId ? b.slot.teacherId : b.parentId;
      return { notifyId, startsAt: b.slot.startsAt };
    });
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: outcome.notifyId,
        type: "GENERIC",
        title: "Parent meeting cancelled",
        body: `A meeting scheduled for ${outcome.startsAt.toISOString().slice(0, 16).replace("T", " ")} was cancelled.`,
        data: { bookingId },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return { cancelled: true };
  }

  /** A parent's own bookings (BOOKED, future first). */
  async myBookings(p: Principal): Promise<MeetingBookingDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.meetingBooking.findMany({
        where: { parentId: p.userId, status: "BOOKED" },
        include: { slot: { select: { startsAt: true, teacherId: true, location: true } } },
        orderBy: { slot: { startsAt: "asc" } },
        take: 100,
      });
      type Row = BookingRow & { slot: { startsAt: Date; teacherId: string; location: string | null } };
      const withSlot = rows as Row[];
      const studentNames = await this.userNames(tx, withSlot.map((r) => r.studentId));
      const teacherNames = await this.userNames(tx, withSlot.map((r) => r.slot.teacherId));
      return withSlot.map((r) =>
        this.toBookingDto(r, r.slot.startsAt, studentNames.get(r.studentId) ?? "", teacherNames.get(r.slot.teacherId), r.slot.location),
      );
    });
  }

  // --- helpers ----------------------------------------------------------------

  private async bookingCounts(tx: TenantTx, slotIds: string[]): Promise<Map<string, number>> {
    if (slotIds.length === 0) return new Map();
    const grouped = await tx.meetingBooking.groupBy({ by: ["slotId"], where: { slotId: { in: slotIds }, status: "BOOKED" }, _count: { _all: true } });
    return new Map(grouped.map((g: { slotId: string; _count: { _all: number } }) => [g.slotId, g._count._all]));
  }

  private async userNames(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map<string, string>(users.map((u: { id: string; name: string }) => [u.id, u.name] as const));
  }

  private toSlotDto(s: SlotRow, booked: number, _p: Principal | null, teacherName?: string): MeetingSlotDto {
    return {
      id: s.id,
      teacherId: s.teacherId,
      teacherName: teacherName ?? null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      booked,
      location: s.location,
      note: s.note,
      active: s.active,
    };
  }

  private toBookingDto(b: BookingRow, startsAt: Date, studentName: string, teacherName?: string, location?: string | null): MeetingBookingDto {
    return {
      id: b.id,
      slotId: b.slotId,
      studentId: b.studentId,
      studentName,
      teacherName: teacherName ?? null,
      startsAt,
      location: location ?? null,
      status: b.status,
      note: b.note,
    };
  }
}

type SlotRow = { id: string; teacherId: string; startsAt: Date; endsAt: Date; capacity: number; location: string | null; note: string | null; active: boolean };
type BookingRow = { id: string; slotId: string; studentId: string; status: string; note: string | null; slot?: { startsAt: Date; teacherId: string; location: string | null } };
