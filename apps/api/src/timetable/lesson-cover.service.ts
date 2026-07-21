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
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";

const DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
const MAX_WINDOW_DAYS = 62;

@Injectable()
export class LessonCoverService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
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
        select: { id: true, classId: true, subject: true, teacherId: true, dayOfWeek: true, periodId: true },
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
        select: { id: true, classId: true, subject: true, dayOfWeek: true, periodId: true, teacherId: true },
      });
      if (!entry) throw new NotFoundException("Lesson not found");
      if (entry.dayOfWeek !== DOW[date.getUTCDay()]) {
        throw new BadRequestException("That date is not the lesson's weekday");
      }
      const reliever = await tx.user.findFirst({ where: { id: input.coveringTeacherId }, select: { id: true, name: true } });
      if (!reliever) throw new NotFoundException("Teacher not found");
      if (input.coveringTeacherId === entry.teacherId) {
        throw new BadRequestException("The absent teacher cannot cover their own lesson");
      }
      // Double-booking: the reliever's OWN lesson at this period on this weekday,
      // OR another cover already assigned to them at this period/date.
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
      subject: result.entry.subject,
      absentTeacherId: result.entry.teacherId,
      absentTeacherName: "",
      coverId: result.row.id,
      coveringTeacherId: input.coveringTeacherId,
      coveringTeacherName: result.reliever.name,
      note: input.note ?? null,
    };
  }

  /** Remove a cover assignment. timetable.write. */
  async removeCover(p: Principal, id: string): Promise<{ removed: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.lessonCover.deleteMany({ where: { id } });
      if (res.count === 0) throw new NotFoundException("Cover not found");
      await this.audit.record(
        { actorId: p.userId, action: "timetable.cover.remove", entity: "lesson_cover", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { removed: true };
    });
  }

  /** A teacher's own upcoming cover duties. Self-scoped. */
  async myDuties(p: Principal, from: string, to: string): Promise<MyCoverDutyDto[]> {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.lessonCover.findMany({
        where: { coveringTeacherId: p.userId, date: { gte: start, lte: end } },
        orderBy: { date: "asc" },
        include: { timetableEntry: { select: { classId: true, subject: true, periodId: true } } },
      });
      const classIds = [...new Set(rows.map((r: { timetableEntry: { classId: string } }) => r.timetableEntry.classId))] as string[];
      const periodIds = [...new Set(rows.map((r: { timetableEntry: { periodId: string } }) => r.timetableEntry.periodId))] as string[];
      const [classes, periods] = await Promise.all([
        tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
        tx.period.findMany({ where: { id: { in: periodIds } }, select: { id: true, name: true } }),
      ]);
      const className = new Map<string, string>(classes.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      const periodName = new Map<string, string>(periods.map((x: { id: string; name: string }) => [x.id, x.name] as const));
      return rows.map((r: { id: string; date: Date; note: string | null; timetableEntry: { classId: string; subject: string; periodId: string } }) => ({
        coverId: r.id,
        date: this.dateOnly(r.date),
        className: className.get(r.timetableEntry.classId) ?? "",
        subject: r.timetableEntry.subject,
        periodName: periodName.get(r.timetableEntry.periodId) ?? "",
        note: r.note,
      }));
    });
  }
}
