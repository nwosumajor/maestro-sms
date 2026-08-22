// =============================================================================
// LessonCoverService — teacher substitution when a teacher is on leave
// =============================================================================
// Joins two things the system already tracks but never connected: APPROVED
// leave (who's out, which dates) and the weekly timetable (who teaches what,
// which weekday). For a date window it computes each lesson whose regular
// teacher is on leave that day, and lets a timetable manager assign a reliever
// (per calendar date, since the lesson recurs weekly). The reliever is
// notified and a double-booking check keeps them from covering a period they
// already teach. Reads are staff-wide; a teacher sees their own cover duties.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CoverLessonDto, MyCoverDutyDto } from "@sms/types";
import { schoolToday } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import { assertStillHere } from "../common/still-here";
import { lockPerson } from "../common/person-lock";

const DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
const MAX_WINDOW_DAYS = 62;
// What "the next few weeks" means when the caller does not say.
const DEFAULT_COVER_WINDOW_DAYS = 28;

@Injectable()
export class LessonCoverService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * `YYYY-MM-DD` → that day at UTC midnight, or undefined if it is absent or
   * not a date. Anything unparseable is treated as "not given" rather than
   * flowing on as an Invalid Date: a hand-edited query string must not be a
   * 500. A malformed value is rejected outright, since silently answering for
   * a different window than the caller asked for is worse than refusing.
   */
  private parseDay(v: string | undefined): Date | undefined {
    if (v === undefined || v === "") return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException("Date must be YYYY-MM-DD");
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("Date must be YYYY-MM-DD");
    return d;
  }

  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Every lesson within [from,to] whose regular teacher is on APPROVED leave
   *  that day, with any cover already assigned. Staff-wide read. */
  async lessonsNeedingCover(p: Principal, from: string, to: string): Promise<CoverLessonDto[]> {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new BadRequestException("Invalid date range");
    }
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_WINDOW_DAYS) {
      throw new BadRequestException(`Window too large (max ${MAX_WINDOW_DAYS} days)`);
    }
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // Approved leave overlapping the window.
      const leaves = await tx.leaveRequest.findMany({
        where: { status: "APPROVED", startDate: { lte: end }, endDate: { gte: start } },
        select: { userId: true, startDate: true, endDate: true },
      });
      if (leaves.length === 0) return [];
      const teacherIds = [...new Set(leaves.map((l: { userId: string }) => l.userId))];
      const entries = await tx.timetableEntry.findMany({
        where: { teacherId: { in: teacherIds } },
        select: { id: true, classId: true, subject: true, subjectId: true, teacherId: true, dayOfWeek: true, periodId: true },
      });
      if (entries.length === 0) return [];

      // Lookup tables for names.
      const [periods, classes, teachers, covers] = await Promise.all([
        tx.period.findMany({ select: { id: true, name: true, startTime: true } }),
        tx.class.findMany({ select: { id: true, name: true } }),
        tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } }),
        tx.lessonCover.findMany({ where: { date: { gte: start, lte: end } }, select: { id: true, timetableEntryId: true, date: true, coveringTeacherId: true, note: true } }),
      ]);
      const periodName = new Map<string, string>(periods.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      const periodStart = new Map<string, string>(periods.map((x: { id: string; startTime: string }) => [x.id, x.startTime] as const));
      const className = new Map<string, string>(classes.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      const teacherName = new Map<string, string>(teachers.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      const coverNames = new Map<string, string>(
        (await tx.user.findMany({ where: { id: { in: covers.map((c: { coveringTeacherId: string }) => c.coveringTeacherId) } }, select: { id: true, name: true } })).map(
          (x: { id: string; name: string }) => [x.id, x.name] as const,
        ),
      );
      type CoverRow = { id: string; timetableEntryId: string; date: Date; coveringTeacherId: string; note: string | null };
      const coverByKey = new Map<string, CoverRow>(
        (covers as CoverRow[]).map((c) => [`${c.timetableEntryId}|${this.dateOnly(c.date)}`, c] as const),
      );

      const leaveByTeacher = new Map<string, { start: Date; end: Date }[]>();
      for (const l of leaves) {
        const arr = leaveByTeacher.get(l.userId) ?? [];
        arr.push({ start: new Date(l.startDate), end: new Date(l.endDate) });
        leaveByTeacher.set(l.userId, arr);
      }

      const out: CoverLessonDto[] = [];
      for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
        const dow = DOW[d.getUTCDay()];
        const dateStr = this.dateOnly(d);
        for (const e of entries) {
          if (e.dayOfWeek !== dow) continue;
          const spans = leaveByTeacher.get(e.teacherId) ?? [];
          const onLeave = spans.some((s) => d >= s.start && d <= s.end);
          if (!onLeave) continue;
          const cover = coverByKey.get(`${e.id}|${dateStr}`);
          out.push({
            timetableEntryId: e.id,
            date: dateStr,
            dayOfWeek: dow,
            periodName: periodName.get(e.periodId) ?? "",
            periodStart: periodStart.get(e.periodId) ?? "",
            className: className.get(e.classId) ?? "",
            subjectId: e.subjectId,
            subject: e.subject,
            absentTeacherId: e.teacherId,
            absentTeacherName: teacherName.get(e.teacherId) ?? "",
            coverId: cover?.id ?? null,
            coveringTeacherId: cover?.coveringTeacherId ?? null,
            coveringTeacherName: cover ? coverNames.get(cover.coveringTeacherId) ?? "" : null,
            note: cover?.note ?? null,
          });
        }
      }
      out.sort((a, b) => a.date.localeCompare(b.date) || a.periodStart.localeCompare(b.periodStart));
      return out;
    });
  }

  /** Assign (or reassign) a reliever to a dated lesson. timetable.write. */
  async assignCover(
    p: Principal,
    input: { timetableEntryId: string; date: string; coveringTeacherId: string; note?: string },
  ): Promise<CoverLessonDto> {
    const date = new Date(`${input.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException("Invalid date");
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const entry = await tx.timetableEntry.findFirst({
        where: { id: input.timetableEntryId },
        select: { id: true, classId: true, subject: true, subjectId: true, dayOfWeek: true, periodId: true, teacherId: true },
      });
      if (!entry) throw new NotFoundException("Lesson not found");
      if (entry.dayOfWeek !== DOW[date.getUTCDay()]) {
        throw new BadRequestException("That date is not the lesson's weekday");
      }
      // A reliever who has left cannot cover Tuesday period 3, and the whole
      // point of this feature is that the class is not left unattended.
      const reliever = await assertStillHere(tx, input.coveringTeacherId, "Teacher");
      if (input.coveringTeacherId === entry.teacherId) {
        throw new BadRequestException("The absent teacher cannot cover their own lesson");
      }
      // Double-booking: the reliever's OWN lesson at this period on this weekday,
      // OR another cover already assigned to them at this period/date.
      //
      // Serialised on the reliever first: both checks read and then decide in
      // Node, so two requests arriving together would each see a clear diary and
      // each succeed — the same race the exam roster had, with the same result,
      // a person expected in two rooms at once.
      await lockPerson(tx, p.schoolId, input.coveringTeacherId);
      const clashOwn = await tx.timetableEntry.findFirst({
        where: { teacherId: input.coveringTeacherId, dayOfWeek: entry.dayOfWeek, periodId: entry.periodId },
        select: { id: true },
      });
      if (clashOwn) throw new ConflictException("The reliever already teaches their own lesson at that time");
      const clashCover = await tx.lessonCover.findFirst({
        where: {
          coveringTeacherId: input.coveringTeacherId,
          date,
          timetableEntry: { periodId: entry.periodId },
          NOT: { timetableEntryId: input.timetableEntryId },
        },
        select: { id: true },
      });
      if (clashCover) throw new ConflictException("The reliever is already covering another lesson at that time");

      const row = await tx.lessonCover.upsert({
        where: { timetableEntryId_date: { timetableEntryId: input.timetableEntryId, date } },
        create: {
          schoolId: p.schoolId,
          timetableEntryId: input.timetableEntryId,
          date,
          coveringTeacherId: input.coveringTeacherId,
          note: input.note ?? null,
          assignedById: p.userId,
        },
        update: { coveringTeacherId: input.coveringTeacherId, note: input.note ?? null, assignedById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "timetable.cover.assign", entity: "lesson_cover", entityId: row.id, schoolId: p.schoolId, metadata: { timetableEntryId: input.timetableEntryId, date: input.date, coveringTeacherId: input.coveringTeacherId } },
        tx,
      );
      const className = (await tx.class.findFirst({ where: { id: entry.classId }, select: { name: true } }))?.name ?? "";
      const period = await tx.period.findFirst({ where: { id: entry.periodId }, select: { name: true, startTime: true } });
      return { row, entry, reliever, className, periodName: period?.name ?? "", periodStart: period?.startTime ?? "" };
    });

    // Notify the reliever (best-effort, after commit).
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: input.coveringTeacherId,
        type: "GENERIC",
        title: "Cover lesson assigned",
        body: `You've been asked to cover ${result.className} ${result.entry.subject} on ${input.date} (${result.periodName}).${input.note ? ` Note: ${input.note}` : ""}`,
        data: { timetableEntryId: input.timetableEntryId, date: input.date },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }

    return {
      timetableEntryId: input.timetableEntryId,
      date: input.date,
      dayOfWeek: result.entry.dayOfWeek,
      periodName: result.periodName,
      periodStart: result.periodStart,
      className: result.className,
      subjectId: result.entry.subjectId,
      subject: result.entry.subject,
      absentTeacherId: result.entry.teacherId,
      absentTeacherName: "",
      coverId: result.row.id,
      coveringTeacherId: input.coveringTeacherId,
      coveringTeacherName: result.reliever.name,
      note: input.note ?? null,
    };
  }

  /**
   * Remove a cover assignment — and TELL THE RELIEVER.
   *
   * Assigning one notifies them; removing it said nothing, so the only record
   * they had still told them to teach a lesson that is no longer theirs. A
   * teacher who turns up is a wasted free period; a teacher who does not turn up
   * because they assumed it had been withdrawn is a class left unattended, which
   * is the thing this whole feature exists to prevent.
   */
  async removeCover(p: Principal, id: string): Promise<{ removed: boolean }> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Read the row BEFORE deleting it — afterwards there is nobody to tell.
      const row = (await tx.lessonCover.findFirst({
        where: { id },
        select: { coveringTeacherId: true, date: true, timetableEntryId: true },
      })) as { coveringTeacherId: string; date: Date; timetableEntryId: string } | null;
      const res = await tx.lessonCover.deleteMany({ where: { id } });
      if (res.count === 0) throw new NotFoundException("Cover not found");
      await this.audit.record(
        { actorId: p.userId, action: "timetable.cover.remove", entity: "lesson_cover", entityId: id, schoolId: p.schoolId },
        tx,
      );
      if (!row) return null;
      const entry = (await tx.timetableEntry.findFirst({
        where: { id: row.timetableEntryId },
        select: { subject: true, classId: true },
      })) as { subject: string; classId: string } | null;
      const className = entry
        ? ((await tx.class.findFirst({ where: { id: entry.classId }, select: { name: true } })) as { name: string } | null)?.name ?? ""
        : "";
      return { ...row, subject: entry?.subject ?? "", className };
    });
    await this.tellRelieverItIsOff(p, outcome);
    return { removed: true };
  }

  /**
   * The other half of "Cover lesson assigned".
   *
   * Best-effort after the commit, exactly like the assignment notice: the cover
   * is withdrawn whether or not the message gets through, and failing the
   * removal because a notification did not send would leave the roster wrong
   * rather than merely quiet.
   */
  /** Public so a timetable delete — whose cascade removes the cover row — can
   *  send the SAME notice rather than a second wording of it. */
  async announceCoverWithdrawn(
    p: Principal,
    row: { coveringTeacherId: string; date: Date; subject: string; className: string },
  ): Promise<void> {
    return this.tellRelieverItIsOff(p, row);
  }

  private async tellRelieverItIsOff(
    p: Principal,
    row: { coveringTeacherId: string; date: Date; subject: string; className: string } | null,
  ): Promise<void> {
    if (!row) return;
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: row.coveringTeacherId,
        type: "GENERIC",
        title: "A cover lesson was taken off your list",
        body:
          `You are no longer covering ${row.subject || "a lesson"}` +
          `${row.className ? ` for ${row.className}` : ""} on ${row.date.toISOString().slice(0, 10)}. ` +
          `Check your cover list for what you are still down for.`,
        data: {},
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
  }

  /** A teacher's own upcoming cover duties. Self-scoped. */
  /**
   * A teacher's own cover duties.
   *
   * The window is OPTIONAL and defaults on the server, in the SCHOOL's
   * timezone. It used to be required, and the only caller computed it in the
   * browser as `new Date().toISOString()` — the UTC day on the user's own
   * clock. West of UTC that is tomorrow for the last hours of every evening, so
   * a teacher in Toronto checking at 20:00 on Monday asked for Tuesday onward
   * and could not see the duty they were about to cover. "Today" is the
   * school's calendar day here as everywhere else.
   *
   * Omitting them also used to build `new Date("undefinedT00:00:00.000Z")` — an
   * Invalid Date, which Prisma rejects with a 500.
   */
  async myDuties(p: Principal, from?: string, to?: string): Promise<MyCoverDutyDto[]> {
    const { timezone } = await this.region.forSchool(p.schoolId);
    // Already a Date at UTC midnight of the school's calendar day.
    const start = this.parseDay(from) ?? schoolToday(timezone);
    const end =
      this.parseDay(to) ?? new Date(start.getTime() + DEFAULT_COVER_WINDOW_DAYS * 86_400_000);
    if (end < start) throw new BadRequestException("'to' is before 'from'");
    if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw new BadRequestException(`Window cannot exceed ${MAX_WINDOW_DAYS} days`);
    }
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.lessonCover.findMany({
        where: { coveringTeacherId: p.userId, date: { gte: start, lte: end } },
        orderBy: { date: "asc" },
        include: { timetableEntry: { select: { classId: true, subject: true, subjectId: true, periodId: true } } },
      });
      const classIds = [...new Set(rows.map((r: { timetableEntry: { classId: string } }) => r.timetableEntry.classId))] as string[];
      const periodIds = [...new Set(rows.map((r: { timetableEntry: { periodId: string } }) => r.timetableEntry.periodId))] as string[];
      const [classes, periods] = await Promise.all([
        tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
        tx.period.findMany({ where: { id: { in: periodIds } }, select: { id: true, name: true } }),
      ]);
      const className = new Map<string, string>(classes.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      const periodName = new Map<string, string>(periods.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      return rows.map((r: { id: string; date: Date; note: string | null; timetableEntry: { classId: string; subject: string; subjectId: string; periodId: string } }) => ({
        coverId: r.id,
        date: this.dateOnly(r.date),
        className: className.get(r.timetableEntry.classId) ?? "",
        subjectId: r.timetableEntry.subjectId,
        subject: r.timetableEntry.subject,
        periodName: periodName.get(r.timetableEntry.periodId) ?? "",
        note: r.note,
      }));
    });
  }
}
