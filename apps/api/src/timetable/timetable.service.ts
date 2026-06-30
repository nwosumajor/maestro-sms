// =============================================================================
// TimetableService — bell schedule, rooms, and conflict-checked lesson grid
// =============================================================================
// The scheduling logic is CONFLICT DETECTION: a teacher, room, or class can
// never occupy two lessons in the same (dayOfWeek, period). Writes are validated
// against existing entries and rejected with 409. Reads are relationship-scoped:
//   - staff/board (school_admin / principal / board / super_admin) -> all
//   - teacher -> their own lessons + classes they teach
//   - student -> classes they're enrolled in
//   - parent  -> their children's classes
// Everything runs in a tenant transaction (RLS-enforced); mutations audited.
// Not-visible -> 404 (never 403). (Auto-generation via a CSP solver is future.)
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { DayOfWeekValue } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { generateTimetable, type Offering, type Slot } from "./auto-timetable";

const STAFF_WIDE_ROLES = new Set(["school_admin", "principal", "board", "super_admin"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS: DayOfWeekValue[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

export interface PeriodInput {
  name: string;
  sequence: number;
  startTime: string;
  endTime: string;
}
export interface RoomInput {
  name: string;
  capacity?: number | null;
}
export interface EntryInput {
  classId: string;
  dayOfWeek: DayOfWeekValue;
  periodId: string;
  subject: string;
  teacherId: string;
  roomId?: string | null;
}

@Injectable()
export class TimetableService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isStaffWide(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE_ROLES.has(r));
  }

  // --- periods ---------------------------------------------------------------
  async listPeriods(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.period.findMany({ orderBy: { sequence: "asc" } }),
    );
  }

  async createPeriod(p: Principal, input: PeriodInput) {
    this.assertTimes(input.startTime, input.endTime);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const period = await tx.period.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          sequence: input.sequence,
          startTime: input.startTime,
          endTime: input.endTime,
        },
      });
      await this.log(tx, p, "timetable.period.create", "period", period.id);
      return period;
    });
  }

  async updatePeriod(p: Principal, id: string, input: Partial<PeriodInput>) {
    if (input.startTime && input.endTime) this.assertTimes(input.startTime, input.endTime);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.period.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException("Period not found");
      const period = await tx.period.update({ where: { id }, data: input });
      await this.log(tx, p, "timetable.period.update", "period", id);
      return period;
    });
  }

  // --- rooms -----------------------------------------------------------------
  async listRooms(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) => tx.room.findMany({ orderBy: { name: "asc" } }));
  }

  async createRoom(p: Principal, input: RoomInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.room.create({
        data: { schoolId: p.schoolId, name: input.name, capacity: input.capacity ?? null },
      });
      await this.log(tx, p, "timetable.room.create", "room", room.id);
      return room;
    });
  }

  async updateRoom(p: Principal, id: string, input: Partial<RoomInput>) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.room.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException("Room not found");
      const room = await tx.room.update({
        where: { id },
        data: { name: input.name, capacity: input.capacity ?? undefined },
      });
      await this.log(tx, p, "timetable.room.update", "room", id);
      return room;
    });
  }

  // --- entries (conflict-checked) -------------------------------------------
  async createEntry(p: Principal, input: EntryInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertReferencesExist(tx, input);
      await this.assertNoConflict(tx, input);
      const entry = await tx.timetableEntry.create({
        data: {
          schoolId: p.schoolId,
          classId: input.classId,
          dayOfWeek: input.dayOfWeek,
          periodId: input.periodId,
          subject: input.subject,
          teacherId: input.teacherId,
          roomId: input.roomId ?? null,
        },
      });
      await this.log(tx, p, "timetable.entry.create", "timetable_entry", entry.id, {
        classId: input.classId,
        dayOfWeek: input.dayOfWeek,
      });
      return this.loadEntry(tx, entry.id);
    });
  }

  // --- auto-generation (CSP greedy solver) ----------------------------------
  /** Generate a conflict-free weekly grid from class-subject-teacher offerings.
   *  Uses the pure solver (class + teacher no-double-booking) and persists the
   *  placements as TimetableEntry rows. Existing entries are respected, not wiped
   *  (unless `replace` is set, which clears the targeted classes first). Staff only. */
  async generate(
    p: Principal,
    input: { classIds?: string[]; lessonsPerSubject?: number; days?: DayOfWeekValue[]; replace?: boolean },
  ) {
    if (!this.isStaffWide(p)) throw new ForbiddenException();
    const lessonsPerSubject = Math.min(10, Math.max(1, input.lessonsPerSubject ?? 2));
    const days = input.days?.length ? input.days : WEEKDAYS;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const periods = await tx.period.findMany({ orderBy: { sequence: "asc" }, select: { id: true } });
      if (periods.length === 0) throw new BadRequestException("Define at least one period first");
      const slots: Slot[] = [];
      for (const day of days) for (const period of periods) slots.push({ day, periodId: period.id });

      // Offerings: class-subject-teacher rows (optionally a subset of classes).
      const cstWhere = input.classIds?.length ? { classId: { in: input.classIds } } : {};
      const cst = await tx.classSubjectTeacher.findMany({ where: cstWhere });
      if (cst.length === 0) throw new BadRequestException("No class-subject-teacher offerings to schedule");
      const subjectIds = [...new Set(cst.map((c: { subjectId: string }) => c.subjectId))];
      const subjects = await tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } });
      const subjectName = new Map(subjects.map((s: { id: string; name: string }) => [s.id, s.name]));
      const offerings: Offering[] = cst.map((c: { classId: string; subjectId: string; teacherId: string }) => ({
        classId: c.classId,
        subjectId: c.subjectId,
        subject: subjectName.get(c.subjectId) ?? "Subject",
        teacherId: c.teacherId,
        lessonsPerWeek: lessonsPerSubject,
      }));
      const targetClassIds = [...new Set(offerings.map((o) => o.classId))];

      // Optionally clear the targeted classes' existing entries first.
      if (input.replace) {
        await tx.timetableEntry.deleteMany({ where: { classId: { in: targetClassIds } } });
      }

      // Seed busy-sets from any entries we are KEEPING (other classes / not replaced).
      const keep = await tx.timetableEntry.findMany({
        where: input.replace ? { classId: { notIn: targetClassIds } } : {},
        select: { classId: true, teacherId: true, dayOfWeek: true, periodId: true },
      });
      const classBusy: Record<string, Set<string>> = {};
      const teacherBusy: Record<string, Set<string>> = {};
      for (const e of keep as Array<{ classId: string; teacherId: string; dayOfWeek: string; periodId: string }>) {
        const k = `${e.dayOfWeek}|${e.periodId}`;
        (classBusy[k] ??= new Set()).add(e.classId);
        (teacherBusy[k] ??= new Set()).add(e.teacherId);
      }

      const result = generateTimetable(offerings, slots, { classBusy, teacherBusy });
      for (const lesson of result.placed) {
        await tx.timetableEntry.create({
          data: {
            schoolId: p.schoolId,
            classId: lesson.classId,
            dayOfWeek: lesson.day as DayOfWeekValue,
            periodId: lesson.periodId,
            subject: lesson.subject,
            teacherId: lesson.teacherId,
            roomId: null,
          },
        });
      }
      await this.log(tx, p, "timetable.generate", "timetable", "auto", {
        classes: targetClassIds.length,
        placed: result.placed.length,
        unplaced: result.unplaced.length,
        replace: Boolean(input.replace),
      });
      return { placed: result.placed.length, unplaced: result.unplaced };
    });
  }

  async updateEntry(p: Principal, id: string, input: Partial<EntryInput>) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const current = await tx.timetableEntry.findFirst({ where: { id } });
      if (!current) throw new NotFoundException("Timetable entry not found");
      const merged: EntryInput = {
        classId: input.classId ?? current.classId,
        dayOfWeek: (input.dayOfWeek ?? current.dayOfWeek) as DayOfWeekValue,
        periodId: input.periodId ?? current.periodId,
        subject: input.subject ?? current.subject,
        teacherId: input.teacherId ?? current.teacherId,
        roomId: input.roomId === undefined ? current.roomId : input.roomId,
      };
      await this.assertReferencesExist(tx, merged);
      await this.assertNoConflict(tx, merged, id);
      await tx.timetableEntry.update({
        where: { id },
        data: {
          classId: merged.classId,
          dayOfWeek: merged.dayOfWeek,
          periodId: merged.periodId,
          subject: merged.subject,
          teacherId: merged.teacherId,
          roomId: merged.roomId ?? null,
        },
      });
      await this.log(tx, p, "timetable.entry.update", "timetable_entry", id);
      return this.loadEntry(tx, id);
    });
  }

  async deleteEntry(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.timetableEntry.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException("Timetable entry not found");
      await tx.timetableEntry.delete({ where: { id } });
      await this.log(tx, p, "timetable.entry.delete", "timetable_entry", id);
      return { id, deleted: true };
    });
  }

  async listEntries(
    p: Principal,
    opts?: { classId?: string; teacherId?: string; dayOfWeek?: DayOfWeekValue },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts?.dayOfWeek) where.dayOfWeek = opts.dayOfWeek;
      if (opts?.teacherId) where.teacherId = opts.teacherId;

      if (this.isStaffWide(p)) {
        if (opts?.classId) where.classId = opts.classId;
      } else if (p.roles.includes("teacher")) {
        const taught = await this.taughtClassIds(tx, p);
        where.OR = [{ teacherId: p.userId }, { classId: { in: taught } }];
        if (opts?.classId) where.classId = opts.classId;
      } else {
        const classIds = await this.visibleClassIds(tx, p);
        if (classIds.length === 0) return [];
        where.classId =
          opts?.classId && classIds.includes(opts.classId) ? opts.classId : { in: classIds };
      }
      return tx.timetableEntry.findMany({
        where,
        include: { period: true, room: true },
        orderBy: [{ dayOfWeek: "asc" }, { period: { sequence: "asc" } }],
        take: 500,
      });
    });
  }

  /** A single class's weekly grid (scoped). */
  async getClassTimetable(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanViewClass(tx, p, classId);
      return tx.timetableEntry.findMany({
        where: { classId },
        include: { period: true, room: true },
        orderBy: [{ dayOfWeek: "asc" }, { period: { sequence: "asc" } }],
      });
    });
  }

  // --- conflict detection ----------------------------------------------------
  private async assertNoConflict(tx: TenantTx, e: EntryInput, excludeId?: string) {
    const slot = { dayOfWeek: e.dayOfWeek, periodId: e.periodId };
    const not = excludeId ? { id: { not: excludeId } } : {};

    const classClash = await tx.timetableEntry.findFirst({
      where: { ...slot, classId: e.classId, ...not },
      select: { id: true },
    });
    if (classClash) throw new ConflictException("This class already has a lesson in that slot");

    const teacherClash = await tx.timetableEntry.findFirst({
      where: { ...slot, teacherId: e.teacherId, ...not },
      select: { id: true },
    });
    if (teacherClash) throw new ConflictException("That teacher is already booked in that slot");

    if (e.roomId) {
      const roomClash = await tx.timetableEntry.findFirst({
        where: { ...slot, roomId: e.roomId, ...not },
        select: { id: true },
      });
      if (roomClash) throw new ConflictException("That room is already booked in that slot");
    }
  }

  // --- helpers ---------------------------------------------------------------
  private assertTimes(start: string, end: string) {
    if (!HHMM.test(start) || !HHMM.test(end)) {
      throw new BadRequestException("startTime/endTime must be HH:MM (24h)");
    }
    if (start >= end) throw new BadRequestException("startTime must be before endTime");
  }

  private async assertReferencesExist(tx: TenantTx, e: EntryInput) {
    const [cls, period, teacher] = await Promise.all([
      tx.class.findFirst({ where: { id: e.classId }, select: { id: true } }),
      tx.period.findFirst({ where: { id: e.periodId }, select: { id: true } }),
      tx.user.findFirst({ where: { id: e.teacherId }, select: { id: true } }),
    ]);
    if (!cls) throw new NotFoundException("Class not found");
    if (!period) throw new NotFoundException("Period not found");
    if (!teacher) throw new NotFoundException("Teacher not found");
    if (e.roomId) {
      const room = await tx.room.findFirst({ where: { id: e.roomId }, select: { id: true } });
      if (!room) throw new NotFoundException("Room not found");
    }
  }

  private async loadEntry(tx: TenantTx, id: string) {
    return tx.timetableEntry.findFirst({ where: { id }, include: { period: true, room: true } });
  }

  private async taughtClassIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    return taught.map((t: { classId: string }) => t.classId);
  }

  private async visibleClassIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) {
      const enr = await tx.enrollment.findMany({
        where: { studentId: p.userId },
        select: { classId: true },
      });
      enr.forEach((e: { classId: string }) => ids.add(e.classId));
    }
    const children = await tx.parentChild.findMany({
      where: { parentId: p.userId },
      select: { studentId: true },
    });
    if (children.length > 0) {
      const enr = await tx.enrollment.findMany({
        where: { studentId: { in: children.map((c: { studentId: string }) => c.studentId) } },
        select: { classId: true },
      });
      enr.forEach((e: { classId: string }) => ids.add(e.classId));
    }
    return [...ids];
  }

  private async assertCanViewClass(tx: TenantTx, p: Principal, classId: string) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isStaffWide(p)) return;
    if (p.roles.includes("teacher")) {
      const teaches = await tx.classTeacher.findFirst({
        where: { classId, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return;
    }
    const visible = await this.visibleClassIds(tx, p);
    if (visible.includes(classId)) return;
    // SECURITY: 404 (not 403) — don't reveal a class the caller can't see.
    throw new NotFoundException("Class not found");
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
