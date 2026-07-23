// =============================================================================
// AttendanceService — per-class daily registers + relationship scoping
// =============================================================================
// Coarse permissions gate the endpoints; this service narrows ROWS by
// relationship (same model as LMS/SIS):
//   - school staff (school_admin / principal / super_admin) -> any class/student
//   - teacher -> classes they teach (write + read), students in those classes
//   - parent  -> their own children's records (read)
//   - student -> their own records (read)
// Everything runs in a tenant transaction (RLS-enforced); mutations are audited.
// Not-visible -> 404 (never 403). Records are corrected, never deleted.
// =============================================================================

import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import type { AttendanceStatusValue } from "@sms/types";
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

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);
/** Statuses that notify the student's guardians. */
const ALERTING_STATUSES = new Set<AttendanceStatusValue>(["ABSENT", "LATE"]);

export interface MarkInput {
  date: string; // YYYY-MM-DD
  records: { studentId: string; status: AttendanceStatusValue; note?: string | null }[];
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger("Attendance");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  // --- write -----------------------------------------------------------------
  /** Take or correct attendance for a class on a date. Upserts the session and
   *  one record per student. Only enrolled students may be marked. */
  async markAttendance(p: Principal, classId: string, input: MarkInput) {
    const { session, alerts } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId);
      const date = new Date(input.date);
      // TERM LOCK: a register in a term that has ENDED is read-only for everyone,
      // including leadership — the authoritative check (the UI also greys it out).
      const lockBefore = await this.currentTermStart(tx);
      if (lockBefore && date < lockBefore) {
        throw new ConflictException(
          "This register is locked: it falls in a term that has ended. Past-term registers are read-only.",
        );
      }

      // Only students actually enrolled in this class may be marked.
      const enrolled = await tx.enrollment.findMany({
        where: { classId },
        select: { studentId: true },
      });
      const enrolledIds = new Set(enrolled.map((e: { studentId: string }) => e.studentId));
      for (const r of input.records) {
        if (!enrolledIds.has(r.studentId)) {
          throw new BadRequestException(`Student ${r.studentId} is not enrolled in this class`);
        }
      }

      const session = await tx.attendanceSession.upsert({
        where: { classId_date: { classId, date } },
        update: { takenById: p.userId },
        create: { schoolId: p.schoolId, classId, date, takenById: p.userId },
      });

      // ONE statement for the whole register. This used to be a per-student
      // `upsert` in a loop — i.e. a round-trip per student (a 40-pupil class =
      // 40 sequential round-trips) with the tenant transaction held open the
      // whole time, on the highest-volume write in the product (every class,
      // every day). Load-testing made it the slowest endpoint we have. The
      // @@unique([sessionId, studentId]) constraint lets ON CONFLICT express the
      // exact same upsert semantics in a single round-trip.
      // RLS still applies: the INSERT is checked against the school's WITH CHECK
      // policy and the DO UPDATE against the UPDATE policy, same as before.
      const now = new Date();
      const values = input.records.map(
        (r) => Prisma.sql`(${randomUUID()}::uuid, ${p.schoolId}::uuid, ${session.id}::uuid, ${r.studentId}::uuid,
             ${r.status}::"AttendanceStatus", ${r.note ?? null}, ${now}, ${now})`,
      );
      await tx.$executeRaw`
        INSERT INTO "attendance_record" ("id", "schoolId", "sessionId", "studentId", "status", "note", "createdAt", "updatedAt")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("sessionId", "studentId")
        DO UPDATE SET "status" = EXCLUDED."status", "note" = EXCLUDED."note", "updatedAt" = EXCLUDED."updatedAt"
      `;

      await this.log(tx, p, "attendance.mark", "attendance_session", session.id, {
        classId,
        date: input.date,
        count: input.records.length,
      });

      // Resolve guardians of absent/late students (while we hold the tenant tx),
      // to notify them after this transaction commits.
      const alertStudents = input.records
        .filter((r) => ALERTING_STATUSES.has(r.status))
        .map((r) => ({ studentId: r.studentId, status: r.status }));
      const alerts: { guardianId: string; studentId: string; status: AttendanceStatusValue }[] = [];
      if (alertStudents.length > 0) {
        const links = await tx.parentChild.findMany({
          where: { studentId: { in: alertStudents.map((s) => s.studentId) } },
          select: { parentId: true, studentId: true },
        });
        for (const s of alertStudents) {
          for (const l of links.filter((x: { studentId: string }) => x.studentId === s.studentId)) {
            alerts.push({ guardianId: l.parentId, studentId: s.studentId, status: s.status });
          }
        }
      }

      const loaded = await this.loadSession(tx, session.id);
      return { session: loaded, alerts };
    });

    // Best-effort, post-commit: notify each guardian (in-app + email). A failure
    // here never fails the attendance write.
    for (const a of alerts) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: a.guardianId,
          type: "ATTENDANCE_ABSENCE",
          title: "Attendance alert",
          body: `Your child was marked ${a.status} on ${input.date}.`,
          data: { classId, date: input.date, studentId: a.studentId, status: a.status },
          channels: ["EMAIL"],
        });
      } catch (err) {
        this.logger.error(`Attendance notification failed for guardian ${a.guardianId}: ${String(err)}`);
      }
    }

    return session;
  }

  // --- reads -----------------------------------------------------------------
  /** A class's register for a date (or the most recent sessions if no date). */
  async getClassAttendance(p: Principal, classId: string, date?: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId);
      if (date) {
        const session = await tx.attendanceSession.findFirst({
          where: { classId, date: new Date(date) },
        });
        if (!session) return null;
        return this.loadSession(tx, session.id);
      }
      return tx.attendanceSession.findMany({
        where: { classId },
        orderBy: { date: "desc" },
        take: 60,
        include: {
          takenBy: { select: { id: true, name: true } },
          _count: { select: { records: true } },
        },
      });
    });
  }

  /** A student's attendance history (records + their session context). */
  async getStudentAttendance(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      return tx.attendanceRecord.findMany({
        where: { studentId },
        orderBy: { createdAt: "desc" },
        include: { session: { select: { classId: true, date: true } } },
        take: 200,
      });
    });
  }

  // --- helpers ---------------------------------------------------------------
  private async loadSession(tx: TenantTx, sessionId: string) {
    return tx.attendanceSession.findFirst({
      where: { id: sessionId },
      include: {
        takenBy: { select: { id: true, name: true } },
        records: {
          include: { student: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
  }

  /** school-wide staff, or a teacher assigned to THIS class. 404 otherwise. */
  /**
   * The start of the CURRENT term — the lock boundary. A register dated BEFORE
   * this is in a term that has ended and is READ-ONLY. Prefers the explicitly
   * `isCurrent` term; falls back to the term whose date range contains today.
   * Returns null when terms/dates are not configured (fail-open — an unset-up
   * school must never have attendance blocked).
   */
  private async currentTermStart(tx: TenantTx): Promise<Date | null> {
    const marked = await tx.term.findFirst({ where: { isCurrent: true }, select: { startDate: true } });
    if (marked?.startDate) return marked.startDate;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const containing = await tx.term.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
      orderBy: { startDate: "desc" },
      select: { startDate: true },
    });
    return containing?.startDate ?? null;
  }

  /** The lock boundary for the UI: dates before this are read-only. */
  async getTermLock(p: Principal): Promise<{ lockBeforeDate: string | null }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const start = await this.currentTermStart(tx);
      return { lockBeforeDate: start ? start.toISOString().slice(0, 10) : null };
    });
  }

  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    // SECURITY: 404 (not 403) — don't reveal a class the caller can't see.
    if (!teaches) throw new NotFoundException("Class not found");
  }

  /** school staff / self / parent-of-child / teacher-of-the-student. 404 else. */
  private async assertCanAccessStudent(tx: TenantTx, p: Principal, studentId: string) {
    if (this.isSchoolWide(p)) return;
    if (p.userId === studentId) return;

    const link = await tx.parentChild.findFirst({
      where: { parentId: p.userId, studentId },
      select: { id: true },
    });
    if (link) return;

    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (taught.length > 0) {
      const enrolled = await tx.enrollment.findFirst({
        where: { studentId, classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { id: true },
      });
      if (enrolled) return;
    }
    throw new NotFoundException("Student not found");
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
