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
// Not-visible -> 404 (never 403). Auto-generation runs the pure CSP solver in
// auto-timetable.ts over per-offering quotas, TeacherUnavailability rows, and
// preferred rooms, then persists the result as ordinary conflict-free entries.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
// VALUE import — Prisma.PrismaClientKnownRequestError is a class, so `import
// type` would compile and then fail every instanceof at runtime.
import { Prisma } from "@sms/db";
import type {
  DayOfWeekValue,
  UnstaffedLessonDto,
  DayStructureInput,
  TeacherUnavailabilityDto,
  TimetableDiagnosticDto,
  TimetableEntryDto,
  TimetableGenerateResultDto,
} from "@sms/types";
import { generateDayStructure, validateDayStructure } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { generateTimetable, unavailableKey, type Offering, type Slot } from "./auto-timetable";

// junior_admin owns timetabling (CLAUDE.md) and holds timetable.write. It could
// already create periods/rooms/entries (those gate on the permission only), but
// the auto-generator (generate) and teacher-availability (setUnavailability)
// gate on staff-wide — so those were dead for it. Add it for consistency.
// Mirrors the SIS fix.
const STAFF_WIDE_ROLES = new Set(["school_admin", "principal", "board", "junior_admin"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS: DayOfWeekValue[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

/** A timetable entry row as the grid/view queries select it (period + room joined). */
type EntryRow = {
  id: string;
  dayOfWeek: string;
  periodId: string;
  classId: string;
  subjectId: string;
  subject: string;
  teacherId: string;
  roomId: string | null;
  room: { name: string } | null;
};

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
  /** Curriculum Subject id — authoritative. The stored `subject` label is a
   *  server-maintained copy of its name, never operator text. */
  subjectId: string;
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
      await this.assertNoPeriodOverlap(tx, input.startTime, input.endTime);
      const period = await tx.period
        .create({
          data: {
            schoolId: p.schoolId,
            name: input.name,
            sequence: input.sequence,
            startTime: input.startTime,
            endTime: input.endTime,
          },
        })
        .catch((e) => this.rethrowUniqueViolation(e, "Another period already uses that position in the day"));
      await this.log(tx, p, "timetable.period.create", "period", period.id);
      return period;
    });
  }

  async updatePeriod(p: Principal, id: string, input: Partial<PeriodInput>) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = (await tx.period.findFirst({
        where: { id },
        select: { id: true, startTime: true, endTime: true },
      })) as { id: string; startTime: string; endTime: string } | null;
      if (!existing) throw new NotFoundException("Period not found");
      // Validate the row AS IT WILL BE, not the payload. The old check ran only
      // when BOTH times were present, so `PATCH {startTime:"23:00"}` on an
      // 08:00-09:00 period stored 23:00-09:00 — a period ending before it
      // begins, which every downstream ordering then reads as valid.
      const startTime = input.startTime ?? existing.startTime;
      const endTime = input.endTime ?? existing.endTime;
      this.assertTimes(startTime, endTime);
      await this.assertNoPeriodOverlap(tx, startTime, endTime, id);
      const period = await tx.period
        .update({ where: { id }, data: input })
        .catch((e) => this.rethrowUniqueViolation(e, "Another period already uses that position in the day"));
      await this.log(tx, p, "timetable.period.update", "period", id);
      return period;
    });
  }

  /**
   * Delete a period, refusing while lessons are scheduled in it.
   *
   * There was no way to remove a period at all — a mistyped one was permanent
   * unless you regenerated the whole day, which itself refuses once any lesson
   * is placed. So a single typo could only be fixed by clearing the timetable.
   *
   * The guard names what blocks it, because "cannot delete" without a count
   * sends someone hunting through the grid. Teacher-availability rows ARE
   * removed with it: they mark "unavailable in THIS period" and mean nothing
   * once it is gone — the same thing generateDay already does when it replaces
   * the day.
   */
  async deletePeriod(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.period.findFirst({ where: { id }, select: { id: true, name: true } });
      if (!existing) throw new NotFoundException("Period not found");
      const placed = await tx.timetableEntry.count({ where: { periodId: id } });
      if (placed > 0) {
        throw new ConflictException(
          `${placed} lesson${placed === 1 ? " is" : "s are"} scheduled in ${existing.name}. Remove them first.`,
        );
      }
      await tx.teacherUnavailability.deleteMany({ where: { periodId: id } });
      await tx.period.delete({ where: { id } });
      await this.log(tx, p, "timetable.period.delete", "period", id, { name: existing.name });
      return { id, deleted: true };
    });
  }

  /**
   * Generate the whole day from a COUNT-and-POSITION description (teaching-period
   * count + break positions) instead of hand-typed sequence numbers, so the order
   * and clock times are always internally consistent. Replaces the current period
   * set; refuses (409) when lessons are already placed, since those reference the
   * existing periods. Staff-wide only.
   */
  async generateDay(p: Principal, input: DayStructureInput) {
    if (!this.isStaffWide(p)) throw new ForbiddenException();
    const bad = validateDayStructure(input);
    if (bad) throw new BadRequestException(bad);
    const generated = generateDayStructure(input);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const placed = await tx.timetableEntry.count();
      if (placed > 0) {
        throw new ConflictException("Clear the placed timetable first — lessons are scheduled against the current periods.");
      }
      // Old periods (and any teacher-availability tied to them) are replaced.
      await tx.teacherUnavailability.deleteMany({});
      await tx.period.deleteMany({});
      await tx.period.createMany({
        data: generated.map((g) => ({
          schoolId: p.schoolId,
          name: g.name,
          sequence: g.sequence,
          isBreak: g.isBreak,
          startTime: g.startTime,
          endTime: g.endTime,
        })),
      });
      await this.log(tx, p, "timetable.day.generate", "period", "day", {
        teachingPeriods: input.teachingPeriods,
        breaks: input.breaks.length,
        total: generated.length,
      });
      return tx.period.findMany({ orderBy: { sequence: "asc" } });
    });
  }

  // --- rooms -----------------------------------------------------------------
  async listRooms(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) => tx.room.findMany({ orderBy: { name: "asc" } }));
  }

  async createRoom(p: Principal, input: RoomInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const room = await tx.room
        .create({ data: { schoolId: p.schoolId, name: input.name, capacity: input.capacity ?? null } })
        .catch((e) => this.rethrowUniqueViolation(e, "A room with that name already exists"));
      await this.log(tx, p, "timetable.room.create", "room", room.id);
      return room;
    });
  }

  async updateRoom(p: Principal, id: string, input: Partial<RoomInput>) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.room.findFirst({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException("Room not found");
      const room = await tx.room
        .update({ where: { id }, data: { name: input.name, capacity: input.capacity ?? undefined } })
        .catch((e) => this.rethrowUniqueViolation(e, "A room with that name already exists"));
      await this.log(tx, p, "timetable.room.update", "room", id);
      return room;
    });
  }

  /**
   * Delete a room, refusing while lessons are scheduled in it or an offering
   * still prefers it. Same reasoning as deletePeriod: a mistyped room name was
   * otherwise permanent, and it appears in every room picker forever.
   *
   * `preferredRoomId` on a class-subject offering is a SOFT constraint the
   * solver reads. Deleting the room out from under it would leave the offering
   * pointing at nothing, so that blocks too and says which.
   */
  async deleteRoom(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.room.findFirst({ where: { id }, select: { id: true, name: true } });
      if (!existing) throw new NotFoundException("Room not found");
      const [placed, preferred] = await Promise.all([
        tx.timetableEntry.count({ where: { roomId: id } }),
        tx.classSubjectTeacher.count({ where: { preferredRoomId: id } }),
      ]);
      if (placed > 0) {
        throw new ConflictException(
          `${placed} lesson${placed === 1 ? " is" : "s are"} scheduled in ${existing.name}. Move them first.`,
        );
      }
      if (preferred > 0) {
        throw new ConflictException(
          `${preferred} subject offering${preferred === 1 ? "" : "s"} prefer${preferred === 1 ? "s" : ""} ${existing.name}. Clear that preference first.`,
        );
      }
      await tx.room.delete({ where: { id } });
      await this.log(tx, p, "timetable.room.delete", "room", id, { name: existing.name });
      return { id, deleted: true };
    });
  }

  // --- entries (conflict-checked) -------------------------------------------
  async createEntry(p: Principal, input: EntryInput) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertReferencesExist(tx, input);
      await this.assertNoConflict(tx, input);
      const subjectName = await this.subjectLabel(tx, input.subjectId);
      const entry = await tx.timetableEntry
        .create({
          data: {
            schoolId: p.schoolId,
            classId: input.classId,
            dayOfWeek: input.dayOfWeek,
            periodId: input.periodId,
            subjectId: input.subjectId,
            subject: subjectName,
            teacherId: input.teacherId,
            roomId: input.roomId ?? null,
          },
        })
        // assertNoConflict already passed, so a violation here means somebody
        // else took the slot between that check and this insert. We cannot say
        // WHICH of class/teacher/room without a query, and the transaction is
        // already aborted — so say the true thing rather than guess.
        .catch((e) =>
          this.rethrowUniqueViolation(e, "That slot was taken while you were saving. Check the grid and try again."),
        );
      await this.log(tx, p, "timetable.entry.create", "timetable_entry", entry.id, {
        classId: input.classId,
        dayOfWeek: input.dayOfWeek,
      });
      return this.loadEntry(tx, entry.id);
    });
  }

  // --- auto-generation (CSP solver) -----------------------------------------
  /** Generate a conflict-free weekly grid from class-subject-teacher offerings
   *  via the pure CSP solver: per-offering `lessonsPerWeek` quotas, teacher
   *  unavailability, and preferred rooms are hard inputs. Placements persist as
   *  TimetableEntry rows; existing entries are respected, not wiped (unless
   *  `replace` is set, which clears the targeted classes first). Staff only.
   *  Returns operator-facing evidence: unplaced lessons with the blocking
   *  constraint + preflight overload diagnostics, all with display names. */
  async generate(
    p: Principal,
    input: { classIds?: string[]; lessonsPerSubject?: number; days?: DayOfWeekValue[]; replace?: boolean },
  ): Promise<TimetableGenerateResultDto> {
    if (!this.isStaffWide(p)) throw new ForbiddenException();
    const days = input.days?.length ? input.days : WEEKDAYS;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const allPeriods = await tx.period.findMany({ orderBy: { sequence: "asc" }, select: { id: true, isBreak: true } });
      // Break slots are never schedulable — the solver only fills teaching periods.
      const periods = (allPeriods as Array<{ id: string; isBreak: boolean }>).filter((pr) => !pr.isBreak);
      if (periods.length === 0) throw new BadRequestException("Define at least one teaching period first");
      const slots: Slot[] = [];
      for (const day of days) for (const period of periods) slots.push({ day, periodId: period.id });

      // Offerings: class-subject-teacher rows (optionally a subset of classes).
      const cstWhere = input.classIds?.length ? { classId: { in: input.classIds } } : {};
      const cst = await tx.classSubjectTeacher.findMany({ where: cstWhere });
      if (cst.length === 0) throw new BadRequestException("No class-subject-teacher offerings to schedule");
      const subjectIds = [...new Set(cst.map((c) => c.subjectId))];
      const subjects = await tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } });
      const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
      const offerings: Offering[] = cst.map((c) => ({
        classId: c.classId,
        subjectId: c.subjectId,
        subject: subjectName.get(c.subjectId) ?? "Subject",
        teacherId: c.teacherId,
        // The explicit bulk knob (legacy) overrides per-offering quotas when sent.
        lessonsPerWeek: input.lessonsPerSubject ?? c.lessonsPerWeek,
        preferredRoomId: c.preferredRoomId,
      }));
      const targetClassIds = [...new Set(offerings.map((o) => o.classId))];

      // Optionally clear the targeted classes' existing entries first.
      if (input.replace) {
        await tx.timetableEntry.deleteMany({ where: { classId: { in: targetClassIds } } });
      }

      // Seed busy-sets from any entries we are KEEPING (other classes / not replaced).
      const keep = await tx.timetableEntry.findMany({
        where: input.replace ? { classId: { notIn: targetClassIds } } : {},
        select: { classId: true, teacherId: true, dayOfWeek: true, periodId: true, roomId: true },
      });
      const classBusy: Record<string, Set<string>> = {};
      const teacherBusy: Record<string, Set<string>> = {};
      const roomBusy: Record<string, Set<string>> = {};
      for (const e of keep) {
        const k = `${e.dayOfWeek}|${e.periodId}`;
        (classBusy[k] ??= new Set()).add(e.classId);
        (teacherBusy[k] ??= new Set()).add(e.teacherId);
        if (e.roomId) (roomBusy[k] ??= new Set()).add(e.roomId);
      }

      // Teacher availability: unavailable (day, period) slots are hard constraints.
      const teacherIds = [...new Set(offerings.map((o) => o.teacherId))];
      const unavailRows = await tx.teacherUnavailability.findMany({ where: { teacherId: { in: teacherIds } } });
      const unavailable = new Set(unavailRows.map((r) => unavailableKey(r.teacherId, r.dayOfWeek, r.periodId)));

      const result = generateTimetable(offerings, slots, { classBusy, teacherBusy, roomBusy }, unavailable);
      // One bulk insert for all generated lessons (not one INSERT per lesson).
      // The solver planned against the grid as it was READ at the top of this
      // transaction. If someone placed a lesson meanwhile, the constraints
      // reject the whole insert — correctly, since a partly-applied generation
      // is worse than none. Say so rather than surfacing a raw P2002.
      await tx.timetableEntry
        .createMany({
          data: result.placed.map((lesson) => ({
            schoolId: p.schoolId,
            classId: lesson.classId,
            dayOfWeek: lesson.day as DayOfWeekValue,
            periodId: lesson.periodId,
            subjectId: lesson.subjectId,
            subject: lesson.subject,
            teacherId: lesson.teacherId,
            roomId: lesson.roomId,
          })),
        })
        .catch((e) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            throw new ConflictException(
              "The timetable changed while this was generating — nothing was saved. Review the grid and run it again.",
            );
          }
          throw e;
        });

      // Resolve ids -> display names so unplaced/diagnostics read as evidence.
      const classRows = await tx.class.findMany({ where: { id: { in: targetClassIds } }, select: { id: true, name: true } });
      const className = new Map(classRows.map((c) => [c.id, c.name]));
      const teacherRows = await tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } });
      const teacherName = new Map(teacherRows.map((t) => [t.id, t.name]));
      const roomIds = [...new Set(offerings.flatMap((o) => (o.preferredRoomId ? [o.preferredRoomId] : [])))];
      const roomRows = roomIds.length
        ? await tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } })
        : [];
      const roomName = new Map(roomRows.map((r) => [r.id, r.name]));
      const diagnostics: TimetableDiagnosticDto[] = result.diagnostics.map((d) => ({
        kind: d.kind,
        name: d.teacherId
          ? teacherName.get(d.teacherId) ?? d.teacherId
          : d.classId
            ? className.get(d.classId) ?? d.classId
            : roomName.get(d.roomId ?? "") ?? d.roomId ?? "?",
        demand: d.demand,
        capacity: d.capacity,
      }));

      await this.log(tx, p, "timetable.generate", "timetable", "auto", {
        classes: targetClassIds.length,
        placed: result.placed.length,
        unplaced: result.unplaced.length,
        complete: result.complete,
        diagnostics: diagnostics.length,
        replace: Boolean(input.replace),
      });
      return {
        placed: result.placed.length,
        complete: result.complete,
        unplaced: result.unplaced.map((u) => ({
          className: className.get(u.classId) ?? u.classId,
          subject: u.subject,
          teacherName: teacherName.get(u.teacherId) ?? u.teacherId,
          reason: u.reason,
        })),
        diagnostics,
      };
    });
  }

  // --- teacher availability (CSP generator input) ----------------------------
  /** List unavailable slots. School-wide staff see any teacher's (or all);
   *  teachers see only their OWN — the filter narrows silently (404-not-403
   *  posture: no existence leak about other teachers). */
  async listUnavailability(p: Principal, teacherId?: string): Promise<TeacherUnavailabilityDto[]> {
    const effectiveTeacherId = this.isStaffWide(p) ? teacherId : p.userId;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.teacherUnavailability.findMany({
        where: effectiveTeacherId ? { teacherId: effectiveTeacherId } : {},
        orderBy: [{ teacherId: "asc" }, { dayOfWeek: "asc" }, { periodId: "asc" }],
      });
      return rows.map((r) => ({ teacherId: r.teacherId, dayOfWeek: r.dayOfWeek, periodId: r.periodId }));
    });
  }

  /** Replace a teacher's entire unavailability set (idempotent PUT). Staff only. */
  async setUnavailability(
    p: Principal,
    teacherId: string,
    slots: { dayOfWeek: DayOfWeekValue; periodId: string }[],
  ) {
    if (!this.isStaffWide(p)) throw new ForbiddenException();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const teacher = await tx.user.findFirst({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw new NotFoundException("Teacher not found");
      const periodIds = [...new Set(slots.map((s) => s.periodId))];
      if (periodIds.length > 0) {
        const known = await tx.period.count({ where: { id: { in: periodIds } } });
        if (known !== periodIds.length) throw new BadRequestException("Unknown period in availability set");
      }
      await tx.teacherUnavailability.deleteMany({ where: { teacherId } });
      if (slots.length > 0) {
        await tx.teacherUnavailability.createMany({
          data: slots.map((s) => ({
            schoolId: p.schoolId,
            teacherId,
            dayOfWeek: s.dayOfWeek,
            periodId: s.periodId,
          })),
          skipDuplicates: true,
        });
      }
      await this.log(tx, p, "timetable.availability.set", "teacher_unavailability", teacherId, {
        slots: slots.length,
      });
      return { ok: true, slots: slots.length };
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
        subjectId: input.subjectId ?? current.subjectId,
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
          subjectId: merged.subjectId,
          subject: await this.subjectLabel(tx, merged.subjectId),
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

  /** A single class's weekly grid (scoped). Maps to the DTO — including the
   *  teacherId/roomId the web needs to PREFILL an edit form, and the resolved
   *  teacher name (teacherId is a scalar FK, so names are batch-resolved). */
  async getClassTimetable(p: Principal, classId: string): Promise<TimetableEntryDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanViewClass(tx, p, classId);
      const rows = await tx.timetableEntry.findMany({
        where: { classId },
        include: { period: true, room: { select: { name: true } } },
        orderBy: [{ dayOfWeek: "asc" }, { period: { sequence: "asc" } }],
      });
      return this.toEntryDtos(tx, rows as EntryRow[]);
    });
  }

  /**
   * Map entry rows to DTOs, batch-resolving the teacher AND class names.
   *
   * Shared by the class grid and the teacher/room views so all three carry the same
   * fields. teacherId and classId are scalar FKs (the documented pattern that keeps
   * the User model lean), so the names come from two batched lookups — never one
   * query per row.
   */
  private async toEntryDtos(tx: TenantTx, rows: EntryRow[]): Promise<TimetableEntryDto[]> {
    const teacherIds = [...new Set(rows.map((e) => e.teacherId))];
    const classIds = [...new Set(rows.map((e) => e.classId))];
    const [users, classes] = await Promise.all([
      teacherIds.length
        ? (tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } }) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      classIds.length
        ? (tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const classById = new Map(classes.map((c) => [c.id, c.name]));
    return rows.map((e) => ({
      id: e.id,
      dayOfWeek: e.dayOfWeek,
      periodId: e.periodId,
      classId: e.classId,
      className: classById.get(e.classId) ?? "—",
      subjectId: e.subjectId,
      subject: e.subject,
      teacherId: e.teacherId,
      teacherName: nameById.get(e.teacherId) ?? "—",
      roomId: e.roomId,
      room: e.room ? { name: e.room.name } : null,
    }));
  }

  /**
   * One grid, viewed along whichever axis you asked for: a CLASS, a TEACHER, or a
   * ROOM.
   *
   * The teacher axis is the one that was missing in practice. A teacher could only
   * ever open a class grid, so answering "when do I teach?" meant opening each class
   * they teach and scanning for their own name. The room axis answers the question
   * rooms exist for — "what is in Lab 1 on Tuesday?" — which otherwise needed the
   * same manual sweep across every class.
   *
   * Scoping is deliberately the SAME as listEntries, so a teacher asking for another
   * teacher's week gets only the lessons they were already entitled to see, and a
   * student or parent gets only their own classes.
   */
  async getTimetableView(
    p: Principal,
    opts: { classId?: string; teacherId?: string; roomId?: string },
  ): Promise<TimetableEntryDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts.teacherId) where.teacherId = opts.teacherId;
      if (opts.roomId) where.roomId = opts.roomId;

      if (this.isStaffWide(p)) {
        if (opts.classId) where.classId = opts.classId;
      } else if (p.roles.includes("teacher")) {
        const taught = await this.taughtClassIds(tx, p);
        // Their own lessons, or any lesson of a class they teach.
        where.OR = [{ teacherId: p.userId }, { classId: { in: taught } }];
        if (opts.classId) where.classId = opts.classId;
      } else {
        const classIds = await this.visibleClassIds(tx, p);
        if (classIds.length === 0) return [];
        where.classId = opts.classId && classIds.includes(opts.classId) ? opts.classId : { in: classIds };
      }

      const rows = (await tx.timetableEntry.findMany({
        where,
        include: { period: true, room: { select: { name: true } } },
        orderBy: [{ dayOfWeek: "asc" }, { period: { sequence: "asc" } }],
        take: 500,
      })) as EntryRow[];
      return this.toEntryDtos(tx, rows);
    });
  }

  /**
   * The whole grid as CSV — one row per lesson.
   *
   * The PDF prints ONE class or ONE teacher, which is right for a wall or a
   * pupil's folder and useless for the thing an administrator actually does
   * with a timetable: check it in a spreadsheet, or hand the master to whoever
   * builds the exam schedule. There was no CSV at all, and no whole-school
   * print of any kind.
   *
   * Scoping and cost are INHERITED, not re-implemented: it runs through the
   * same `getTimetableView` the screen uses, so a teacher exports exactly the
   * rows they can already see and the read stays the batched one — no per-row
   * lookup, no second scoping rule to keep in step with the first.
   *
   * Omitting every filter gives the whole school, which is why that is
   * staff-wide only — the view already enforces it.
   */
  async exportCsv(
    p: Principal,
    opts: { classId?: string; teacherId?: string; roomId?: string },
  ): Promise<{ csv: string; filename: string }> {
    const rows = await this.getTimetableView(p, opts);
    const periods = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      tx.period.findMany({ orderBy: { sequence: "asc" }, select: { id: true, name: true, startTime: true, endTime: true } }),
    );
    const periodById = new Map(
      (periods as Array<{ id: string; name: string; startTime: string; endTime: string }>).map((x) => [x.id, x]),
    );
    const order = new Map(WEEKDAYS.map((d, i) => [d, i]));

    const header = ["Day", "Period", "Start", "End", "Class", "Subject", "Teacher", "Room"];
    const lines = [header.map((h) => this.csvCell(h)).join(",")];
    for (const r of [...rows].sort(
      (a, b) =>
        (order.get(a.dayOfWeek as DayOfWeekValue) ?? 99) - (order.get(b.dayOfWeek as DayOfWeekValue) ?? 99) ||
        (periodById.get(a.periodId)?.startTime ?? "").localeCompare(periodById.get(b.periodId)?.startTime ?? "") ||
        a.className.localeCompare(b.className),
    )) {
      const per = periodById.get(r.periodId);
      lines.push(
        [
          r.dayOfWeek,
          per?.name ?? "",
          per?.startTime ?? "",
          per?.endTime ?? "",
          r.className,
          r.subject,
          r.teacherName,
          r.room?.name ?? "",
        ]
          .map((v) => this.csvCell(String(v)))
          .join(","),
      );
    }
    const scope = opts.classId ? "class" : opts.teacherId ? "teacher" : opts.roomId ? "room" : "school";
    return { csv: lines.join("\n"), filename: `timetable-${scope}.csv` };
  }

  /** Quoted AND formula-neutralised (OWASP CSV injection): a subject or room
   *  typed as "=cmd" must not execute when the file is opened in a spreadsheet. */
  private csvCell(value: string): string {
    let v = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return `"${v.replace(/"/g, '""')}"`;
  }

  /**
   * Standing teaching load per teacher: periods assigned vs periods they are
   * actually available for.
   *
   * The solver already computes TEACHER_OVERLOAD, but only inside a generate run —
   * it is shown once and discarded, so nobody could ask "who is overloaded right
   * now?" of the timetable as it stands. That is the question behind every request
   * to move a lesson, and the one a head teacher needs before agreeing to one.
   *
   * Capacity is schedulable periods (breaks excluded) x weekdays, MINUS that
   * teacher's own unavailability. Using the raw grid size instead would report a
   * part-time teacher as chronically under-used.
   */
  async getTeacherLoad(
    p: Principal,
  ): Promise<Array<{ teacherId: string; teacherName: string; assigned: number; capacity: number; percent: number }>> {
    if (!this.isStaffWide(p)) throw new ForbiddenException();
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const [periods, entryCounts, unavail] = await Promise.all([
        tx.period.findMany({ select: { id: true, isBreak: true } }) as Promise<Array<{ id: string; isBreak: boolean }>>,
        // One grouped count for the whole school, not a query per teacher.
        tx.timetableEntry.groupBy({ by: ["teacherId"], _count: { _all: true } } as never) as unknown as Promise<
          Array<{ teacherId: string; _count: { _all: number } }>
        >,
        tx.teacherUnavailability.findMany({ select: { teacherId: true } }) as Promise<Array<{ teacherId: string }>>,
      ]);
      const teachingPeriods = periods.filter((pr) => !pr.isBreak).length;
      const grid = teachingPeriods * WEEKDAYS.length;

      const blockedByTeacher = new Map<string, number>();
      for (const u of unavail) blockedByTeacher.set(u.teacherId, (blockedByTeacher.get(u.teacherId) ?? 0) + 1);

      // Everyone who either teaches something or has declared unavailability. A
      // teacher with zero lessons is exactly who a head teacher is looking for, so
      // they must not be omitted just for having no entries.
      const ids = [...new Set([...entryCounts.map((e) => e.teacherId), ...blockedByTeacher.keys()])];
      if (ids.length === 0) return [];
      const users = (await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
        id: string;
        name: string;
      }>;
      const assignedBy = new Map(entryCounts.map((e) => [e.teacherId, e._count._all]));

      return users
        .map((u) => {
          const assigned = assignedBy.get(u.id) ?? 0;
          const capacity = Math.max(0, grid - (blockedByTeacher.get(u.id) ?? 0));
          return {
            teacherId: u.id,
            teacherName: u.name,
            assigned,
            capacity,
            percent: capacity > 0 ? Math.round((assigned / capacity) * 100) : 0,
          };
        })
        // Heaviest first: the ones at risk are what the panel is for.
        .sort((a, b) => b.percent - a.percent || a.teacherName.localeCompare(b.teacherName));
    });
  }

  // --- printable timetable -----------------------------------------------------

  /**
   * The timetable as a printable landscape grid, for a class or a teacher.
   *
   * A class timetable is the single most-printed artefact in a school — pinned on the
   * classroom wall, handed to each pupil, taped inside a staff planner — and there
   * was no output of any kind. Every other document in the product (report cards,
   * payslips, receipts, certificates, exam sheets) had one.
   *
   * Reuses getTimetableView, so what prints is exactly what the caller is allowed to
   * see on screen; a parent cannot print another class's week.
   */
  async timetablePdf(
    p: Principal,
    opts: { classId?: string; teacherId?: string },
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!opts.classId && !opts.teacherId) throw new BadRequestException("Give a classId or a teacherId");
    // A TEACHER's sheet is for staff, or for that teacher themselves.
    //
    // The row scoping below would already keep a parent from SEEING lessons they are
    // not entitled to — but it would hand them a document titled "Teaching timetable
    // — <name>" containing only the fraction of it their child happens to be in.
    // That is not a leak; it is a partial document labelled as a complete one, which
    // someone will print and act on. A teacher's week is not a parent-facing artefact
    // in the first place, so the axis itself is gated.
    if (opts.teacherId && opts.teacherId !== p.userId && !this.isStaffWide(p) && !p.roles.includes("teacher")) {
      throw new ForbiddenException("A teacher's timetable is available to staff, or to that teacher");
    }
    const entries = await this.getTimetableView(p, opts);
    const { periods, schoolName, subjectLabel } = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const [rows, school, cls, teacher] = await Promise.all([
        tx.period.findMany({ orderBy: { sequence: "asc" }, select: { id: true, name: true, startTime: true, endTime: true, isBreak: true } }) as Promise<
          Array<{ id: string; name: string; startTime: string; endTime: string; isBreak: boolean }>
        >,
        tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } }) as Promise<{ name: string } | null>,
        opts.classId
          ? (tx.class.findFirst({ where: { id: opts.classId }, select: { name: true } }) as Promise<{ name: string } | null>)
          : Promise.resolve(null),
        opts.teacherId
          ? (tx.user.findFirst({ where: { id: opts.teacherId }, select: { name: true } }) as Promise<{ name: string } | null>)
          : Promise.resolve(null),
      ]);
      // 404 rather than an empty sheet: printing a blank grid for an id that does not
      // exist in this tenant would look like "there are no lessons".
      if (opts.classId && !cls) throw new NotFoundException("Class not found");
      if (opts.teacherId && !teacher) throw new NotFoundException("Teacher not found");
      return { periods: rows, schoolName: school?.name ?? "", subjectLabel: cls?.name ?? teacher?.name ?? "" };
    });

    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.log(tx, p, "timetable.print", "timetable", opts.classId ?? opts.teacherId ?? "", {
        axis: opts.classId ? "class" : "teacher",
        lessons: entries.length,
      }),
    );

    const buffer = await this.renderTimetablePdf({
      schoolName,
      title: opts.classId ? `Timetable — ${subjectLabel}` : `Teaching timetable — ${subjectLabel}`,
      byTeacher: !!opts.teacherId,
      periods,
      entries,
    });
    const safe = subjectLabel.replace(/[^a-zA-Z0-9-_]+/g, "_") || "timetable";
    return { buffer, filename: `timetable-${safe}.pdf` };
  }

  private async renderTimetablePdf(d: {
    schoolName: string;
    title: string;
    byTeacher: boolean;
    periods: Array<{ id: string; name: string; startTime: string; endTime: string; isBreak: boolean }>;
    entries: TimetableEntryDto[];
  }): Promise<Buffer> {
    const { default: PDFDocument } = await import("pdfkit");
    return new Promise<Buffer>((resolve, reject) => {
      // LANDSCAPE: five weekday columns beside a period column do not fit portrait
      // without shrinking the text past the point of being readable on a wall.
      const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(14).text(d.schoolName, { align: "center" });
      doc.fontSize(11).text(d.title, { align: "center" });
      doc.moveDown(0.5);

      const left = doc.page.margins.left;
      const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const periodW = 90;
      const dayW = (usable - periodW) / WEEKDAYS.length;
      const rowH = Math.max(30, Math.min(52, (doc.page.height - doc.y - 60) / Math.max(1, d.periods.length + 1)));

      let y = doc.y;
      // Header row.
      doc.fontSize(9);
      doc.rect(left, y, periodW, rowH * 0.7).stroke();
      doc.text("Period", left + 4, y + 6, { width: periodW - 8 });
      WEEKDAYS.forEach((day, i) => {
        const x = left + periodW + i * dayW;
        doc.rect(x, y, dayW, rowH * 0.7).stroke();
        doc.text(day.charAt(0) + day.slice(1).toLowerCase(), x + 4, y + 6, { width: dayW - 8 });
      });
      y += rowH * 0.7;

      for (const pr of d.periods) {
        doc.rect(left, y, periodW, rowH).stroke();
        doc.fontSize(8.5).text(pr.name, left + 4, y + 5, { width: periodW - 8, ellipsis: true });
        doc.fontSize(7).fillColor("#666").text(`${pr.startTime}–${pr.endTime}`, left + 4, y + 16, { width: periodW - 8 });
        doc.fillColor("#000");

        WEEKDAYS.forEach((day, i) => {
          const x = left + periodW + i * dayW;
          doc.rect(x, y, dayW, rowH).stroke();
          // A break spans the row as a labelled band — leaving it blank makes a
          // printed timetable look like it has a hole in it.
          if (pr.isBreak) {
            doc.fontSize(7.5).fillColor("#888").text("break", x + 4, y + rowH / 2 - 4, { width: dayW - 8, align: "center" });
            doc.fillColor("#000");
            return;
          }
          const e = d.entries.find((x2) => x2.periodId === pr.id && x2.dayOfWeek === day);
          if (!e) return;
          doc.fontSize(8.5).text(e.subject, x + 4, y + 5, { width: dayW - 8, ellipsis: true });
          // On a TEACHER's sheet the class is the useful line; on a CLASS's sheet it
          // is the teacher. Printing both would not fit and would bury the one that
          // matters.
          const second = d.byTeacher ? e.className : e.teacherName;
          doc.fontSize(7).fillColor("#555").text(second, x + 4, y + 16, { width: dayW - 8, ellipsis: true });
          if (e.room) doc.text(e.room.name, x + 4, y + 25, { width: dayW - 8, ellipsis: true });
          doc.fillColor("#000");
        });
        y += rowH;
      }

      if (d.periods.length === 0) {
        doc.fontSize(9).text("No periods defined yet.", left, y + 10);
      }

      doc.fontSize(7).fillColor("#888").text(
        `${d.entries.length} lesson${d.entries.length === 1 ? "" : "s"} · printed ${new Date().toISOString().slice(0, 10)}`,
        left,
        doc.page.height - doc.page.margins.bottom - 12,
      );

      doc.end();
    });
  }

  /**
   * Turn a unique-constraint violation into a 409 the caller can act on.
   *
   * The CALLER says what a collision means, because Prisma does not: this
   * deployment reports `Unique constraint failed on the (not available)` with
   * `meta.target` absent, so keying off the column list silently never matched
   * and every duplicate stayed a 500. My first version did exactly that, and
   * the unit tests passed only because the fixture supplied a target the real
   * database never sends.
   *
   * Do not re-query here to identify the constraint — the failed statement has
   * already aborted the surrounding transaction, so any follow-up read fails too.
   */
  private rethrowUniqueViolation(e: unknown, message: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictException(message);
    }
    throw e;
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

  /**
   * A bell schedule cannot have two periods running at once.
   *
   * `generateDay` produces a clean non-overlapping day, but a hand-created
   * period was checked only for start<end — so 08:30-09:30 could be added
   * alongside 08:00-09:00 and both would show in the grid, with a lesson
   * placeable in each. Times are "HH:MM" and zero-padded, so string comparison
   * IS chronological comparison; no parsing needed.
   *
   * Half-open intervals: a period ending 09:00 and one starting 09:00 do not
   * overlap, which is the normal back-to-back case.
   */
  private async assertNoPeriodOverlap(tx: TenantTx, start: string, end: string, excludeId?: string) {
    const clash = (await tx.period.findFirst({
      where: {
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { name: true, startTime: true, endTime: true },
    })) as { name: string; startTime: string; endTime: string } | null;
    if (clash) {
      throw new ConflictException(
        `That overlaps ${clash.name} (${clash.startTime}-${clash.endTime}). Periods cannot run at the same time.`,
      );
    }
  }

  // --- helpers ---------------------------------------------------------------
  private assertTimes(start: string, end: string) {
    if (!HHMM.test(start) || !HHMM.test(end)) {
      throw new BadRequestException("startTime/endTime must be HH:MM (24h)");
    }
    if (start >= end) throw new BadRequestException("startTime must be before endTime");
  }

  /** The registry name for a subject — the ONLY source of a lesson's label, so a
   *  timetable can never display a subject that isn't in the catalog. */
  private async subjectLabel(tx: TenantTx, subjectId: string): Promise<string> {
    const s = await tx.subject.findFirst({ where: { id: subjectId }, select: { name: true } });
    if (!s) throw new NotFoundException("Subject not found");
    return s.name;
  }

  private async assertReferencesExist(tx: TenantTx, e: EntryInput) {
    const [cls, period, teacher, subject] = await Promise.all([
      tx.class.findFirst({ where: { id: e.classId }, select: { id: true } }),
      tx.period.findFirst({ where: { id: e.periodId }, select: { id: true, isBreak: true } }),
      tx.user.findFirst({ where: { id: e.teacherId }, select: { id: true } }),
      tx.subject.findFirst({ where: { id: e.subjectId }, select: { id: true } }),
    ]);
    if (!subject) throw new NotFoundException("Subject not found");
    if (!cls) throw new NotFoundException("Class not found");
    if (!period) throw new NotFoundException("Period not found");
    // A break is a non-teaching slot — no lesson may be placed in it.
    if ((period as { isBreak?: boolean }).isBreak) throw new BadRequestException("This is a break period — no lesson can be scheduled in it.");
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

  /**
   * Lessons whose regular teacher has LEFT the school.
   *
   * WHY THIS EXISTS. A departure closes the employment record and the account,
   * but it does not touch the timetable — so the lessons stay, timetabled to
   * somebody who will not arrive, and NOTHING anywhere says so. The class turns
   * up, the room is booked, the grid renders normally, and the school finds out
   * when thirty pupils sit unattended.
   *
   * Deliberately NOT the cover feature. Cover answers "who is out today"
   * (approved leave, a bounded window, assign a reliever for that date). This
   * answers "which lessons have no teacher at all, permanently" — a staffing
   * decision, not a daily one. Folding it into cover would have offered a
   * reliever for one Tuesday on a vacancy that needs filling for the year.
   *
   * A read, and only a read: it changes nothing and reassigns nothing, because
   * who takes over a departed colleague's classes is a decision a human makes.
   */
  async unstaffedLessons(p: Principal): Promise<UnstaffedLessonDto[]> {
    if (!this.isStaffWide(p)) {
      // Whole-school staffing, so whole-school staff only. 404 rather than 403
      // — the same posture as every other out-of-scope read here.
      throw new NotFoundException("Not found");
    }
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // ONE joined query. These models carry scalar ids with FKs in the DB and
      // no Prisma relations (the documented pattern that keeps `User` lean), so
      // the alternative is four round trips and a manual join in Node — for a
      // page a school opens precisely when it is already short-staffed.
      //
      // RLS still applies: this runs inside the tenant transaction, so the
      // policies scope every table to the caller's school without a schoolId
      // predicate having to be written here by hand and kept right.
      const rows = await tx.$queryRaw<
        Array<{
          entryId: string;
          dayOfWeek: string;
          periodName: string | null;
          startTime: string | null;
          classId: string | null;
          className: string | null;
          subjectName: string | null;
          teacherId: string;
          teacherName: string | null;
          leftOn: Date | null;
        }>
      >`
        SELECT te.id                AS "entryId",
               te."dayOfWeek"::text AS "dayOfWeek",
               p.name               AS "periodName",
               p."startTime"        AS "startTime",
               c.id                 AS "classId",
               c.name               AS "className",
               te.subject           AS "subjectName",
               te."teacherId"       AS "teacherId",
               u.name               AS "teacherName",
               u."exitedAt"         AS "leftOn"
        FROM timetable_entry te
        JOIN "user" u ON u.id = te."teacherId" AND u.status <> 'ACTIVE'
        LEFT JOIN period p ON p.id = te."periodId"
        LEFT JOIN class c  ON c.id = te."classId"
        ORDER BY te."dayOfWeek", p."startTime"
      `;
      return rows.map((r) => ({
        entryId: r.entryId,
        dayOfWeek: r.dayOfWeek,
        periodName: r.periodName ?? "\u2014",
        startsAt: r.startTime ?? null,
        classId: r.classId,
        className: r.className ?? "\u2014",
        subjectName: r.subjectName ?? null,
        teacherId: r.teacherId,
        teacherName: r.teacherName ?? "\u2014",
        leftOn: r.leftOn,
      }));
    });
  }
}
