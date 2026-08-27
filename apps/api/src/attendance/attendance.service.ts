// =============================================================================
// AttendanceService — per-class daily registers + relationship scoping
// =============================================================================
// Coarse permissions gate the endpoints; this service narrows ROWS by
// relationship (same model as LMS/SIS):
//   - school staff (school_admin / principal / junior_admin) -> any class/student
//   - teacher -> classes they teach (write + read), students in those classes
//   - parent  -> their own children's records (read)
//   - student -> their own records (read)
// Everything runs in a tenant transaction (RLS-enforced); mutations are audited.
// Not-visible -> 404 (never 403). Records are corrected, never deleted.
// =============================================================================

import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import type { AttendanceStatusValue } from "@sms/types";
import { ATTENDANCE_AMENDMENT_CHAIN, dayUtc, schoolToday, WORKFLOW_PERMISSIONS, attendanceRatePct } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { currentTermStartInTx, holidayOn, registerClosedReason } from "./register-window";
import { NotificationService } from "../notifications/notification.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import { dateWindow } from "../common/status-filter";

// junior_admin is the operational tier that owns attendance (CLAUDE.md) and holds
// attendance.write; without a class relationship to fall back on it would be
// 404'd on every register, so it belongs in the school-wide set. It lacks
// attendance.amend.review, so stale (>7-day) edits still route through
// maker-checker like any non-approver. Mirrors the SIS fix.
const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "junior_admin"]);
/**
 * Roles that may take ANY class's register, to cover an absent supervisor.
 *
 * Deliberately narrower than SCHOOL_WIDE_ROLES, which governs VIEWING. Principal,
 * head teacher and junior_admin see every register and can no longer write one:
 * the register is a record of who physically looked at the room, and cover is an
 * administrative act with a named owner rather than something seniority confers.
 *
 * super_admin is deliberately in NEITHER set. A platform operator has no business
 * recording, or reading, which named child was in a classroom on a given morning;
 * when support genuinely needs to see it they impersonate a member of the school's
 * own staff, which is step-up gated and audited against the operator by name.
 * See test/security/no-standing-superadmin.spec.ts.
 */
const REGISTER_COVER_ROLES = new Set(["school_admin"]);
/** Edits to a register older than this (days) need maker-checker approval. */
const STALE_REGISTER_DAYS = 7;
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
    private readonly workflow: WorkflowService,
    private readonly region: SchoolRegionService,
    hooks: WorkflowHooksService,
  ) {
    // Maker-checker reactor: when a head teacher / school admin / principal (a
    // DIFFERENT person than the teacher) approves a stale-register amendment, the
    // marks are applied in the SAME tenant tx as the transition. Old-date
    // guardian alerts are deliberately NOT sent (not time-sensitive).
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "ATTENDANCE_AMENDMENT" || req.state !== "APPROVED") return;
      const pl = req.payload as { classId?: string; date?: string; records?: MarkInput["records"] } | null;
      if (!pl?.classId || !pl.date || !pl.records) return;
      const date = new Date(pl.date);
      // THE TERM LOCK IS RE-ASKED HERE, because approval happens LATER.
      //
      // It is checked when the amendment is RAISED and again on the direct-write
      // path, and this reactor called `applyRegister` — the low-level write —
      // with neither. An amendment raised inside the current term can sit
      // pending while the term rolls over (the roll-over is a nightly job), and
      // approving it then wrote into a term that is closed. The rule is not
      // "hard to do": it is "no edit EVEN WITH APPROVAL", and this was the one
      // path where an approval was the thing doing it.
      //
      // It matters because a closed term is treated as frozen everywhere else: a
      // report card for it has already been printed and filed in the vault, and
      // `attendance_term_rollup` has already been computed — neither follows a
      // register that moves afterwards.
      // THE HOLIDAY IS RE-ASKED FOR THE SAME REASON, and was not.
      //
      // Both rules are checked when the amendment is RAISED and on the direct
      // write path; only the term lock was re-checked here. A school can declare
      // a holiday — a closure for weather, a public holiday announced late —
      // covering a date whose amendment is already pending, and approving it
      // then wrote a register for a day the school itself records as closed.
      // Same argument, same window: approval happens LATER than the check.
      const today = await this.region.todayInTx(tx, req.schoolId);
      const closed = await registerClosedReason(tx, date, today);
      if (closed) {
        // THROWN, not skipped. The hook runs in the SAME transaction as the
        // transition, so this rolls the approval back and tells the approver
        // why — applying nothing while recording APPROVED would leave them
        // believing a register had been corrected.
        //
        // Each reason says what CHANGED while the request was waiting, not the
        // wording the raise path uses: the approver did nothing wrong and needs
        // to know why an approval they just gave did not take effect.
        throw new ConflictException(
          closed.kind === "TERM_CLOSED"
            ? "That term closed while this amendment was awaiting approval, and past-term registers are read-only. " +
              "The correction was not applied."
            : `${closed.reason} That was declared while this amendment was awaiting approval, so the correction was not applied.`,
        );
      }
      await this.applyRegister(tx, req.schoolId, req.initiatorId, pl.classId, date, pl.records, {
        makerChecker: true,
        requestId: req.id,
      });
    });
  }

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
    const date = new Date(input.date);
    const isApprover = p.permissions.includes(WORKFLOW_PERMISSIONS.ATTENDANCE_AMEND_REVIEW);
    // "Older than seven days" means seven of the SCHOOL's days. Measured against
    // the server's UTC day, a register west of UTC counted as a day older than it
    // was for part of every day — pushing an ordinary correction into
    // maker-checker a day early.
    const schoolNow = schoolToday((await this.region.forSchool(p.schoolId)).timezone);

    // A REGISTER CANNOT BE TAKEN FOR A DAY THAT HAS NOT HAPPENED.
    //
    // There was a guard for the past — a term that has ended is read-only — and
    // none at all for the future. `daysSince` goes NEGATIVE for a future date,
    // so such a register was not even "stale" and went straight through:
    // measured live, marking a pupil ABSENT on 2027-06-01 and on 2030-01-15
    // both answered 201.
    //
    // Two costs. An ABSENT or LATE mark notifies the guardians, so a family
    // could be told their child missed a day that has not come. And attendance
    // feeds the rate on the report card, where a future absence is simply a
    // wrong figure about a child.
    //
    // It also protects the partitioning: `attendance_record` is RANGE-
    // partitioned by month with partitions provisioned three months ahead, so a
    // mistyped year lands in the DEFAULT partition — measured, two of those
    // three did — and those rows must be migrated out by hand before a real
    // partition can ever be created for their month.
    //
    // TODAY is allowed, which is the ordinary case. The school's own day, not
    // the server's: a register taken on a Singapore morning is not tomorrow.
    if (this.daysSince(date, schoolNow) < 0) {
      throw new BadRequestException(
        "A register cannot be taken for a date in the future. Check the date and try again.",
      );
    }

    const stale = this.daysSince(date, schoolNow) > STALE_REGISTER_DAYS;

    // MAKER-CHECKER on a STALE register (>7 days old): a plain teacher's edit is
    // not applied directly — it raises an ATTENDANCE_AMENDMENT a head teacher /
    // school admin / principal must approve. Leadership (holders of
    // attendance.amend.review) edit stale registers directly.
    if (stale && !isApprover) {
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        // Write intent, so the WRITE guard — raising an amendment for a class you
        // may not take is just a slower rejection.
        await this.assertCanTakeRegister(tx, p, classId);
        await this.assertNotHoliday(tx, date);
        const lockBefore = await this.currentTermStart(tx, p.schoolId);
        if (lockBefore && date < lockBefore) {
          throw new ConflictException(
            "This register is locked: it falls in a term that has ended. Past-term registers are read-only.",
          );
        }
        await this.assertAllEnrolled(tx, classId, input.records);
      });
      const req = (await this.workflow.createRequest(p, {
        type: "ATTENDANCE_AMENDMENT",
        title: `Attendance amendment — ${input.date}`,
        payload: { classId, date: input.date, records: input.records },
        stages: [...ATTENDANCE_AMENDMENT_CHAIN],
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true as const, requestId: req.id, date: input.date };
    }

    const { session, alerts } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanTakeRegister(tx, p, classId);
      await this.assertNotHoliday(tx, date);
      // TERM LOCK: a register in a term that has ENDED is read-only for everyone,
      // including leadership — the authoritative check (the UI also greys it out).
      const lockBefore = await this.currentTermStart(tx, p.schoolId);
      if (lockBefore && date < lockBefore) {
        throw new ConflictException(
          "This register is locked: it falls in a term that has ended. Past-term registers are read-only.",
        );
      }
      await this.assertAllEnrolled(tx, classId, input.records);
      return this.applyRegister(tx, p.schoolId, p.userId, classId, date, input.records, { makerChecker: false });
    });

    // Best-effort, post-commit guardian alerts. A failure here never fails the
    // attendance write.
    //
    // BATCHED per distinct message. This was one transaction and queue round-trip
    // per guardian, which is fine for the usual two or three absences but not for
    // the days that actually matter — a strike, a flood, a bus that never arrived —
    // when a teacher marks a whole class absent and the register write then waits on
    // 40+ sequential notifications. Alerts are grouped by (status, student) because
    // the body names both, so siblings' guardians still get the right message.
    const groups = new Map<string, { status: string; studentId: string; guardianIds: string[] }>();
    for (const a of alerts) {
      const key = `${a.status}:${a.studentId}`;
      const g = groups.get(key) ?? { status: a.status, studentId: a.studentId, guardianIds: [] };
      g.guardianIds.push(a.guardianId);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      try {
        await this.notifications.enqueueMany(this.ctx(p), g.guardianIds, {
          // Two types, not one message with two keys: a guardian must be able to
          // switch off "arrived late" without also switching off "did not
          // arrive". ATTENDANCE_ABSENCE is essential and cannot be muted.
          type: g.status === "LATE" ? "ATTENDANCE_LATE" : "ATTENDANCE_ABSENCE",
          // Written in each GUARDIAN's own language — enqueueMany renders per
          // recipient, so a class whose families do not share one still gets it
          // right. The title/body below stay as the English fallback for a
          // recipient whose language has no catalogue entry.
          key: g.status === "LATE" ? "attendance.late" : "attendance.absent",
          params: { date: input.date },
          title: "Attendance alert",
          body: `Your child was marked ${g.status} on ${input.date}.`,
          data: { classId, date: input.date, studentId: g.studentId, status: g.status },
          channels: ["EMAIL"],
        });
      } catch (err) {
        this.logger.error(`Attendance notification failed for student ${g.studentId}: ${String(err)}`);
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

  /**
   * A student's attendance history — PAGED, with the true total.
   *
   * This used to be `take: 200` and nothing else. At roughly 190 school days a year
   * that is about ONE year, so a pupil in their fifth year had four years of history
   * that no page could reach and nothing on screen said so — the reader simply saw
   * the list end. A principal asked to account for a leaver's attendance record got
   * a confidently-presented fraction of it.
   *
   * Offset paging (rather than a cursor) is the right tool here precisely because
   * this history is IMMUTABLE: the term lock freezes every register before the
   * current term, so pages cannot shift under the reader the way a live financial
   * list can. It also gives a total, which is what makes "5 years" navigable at all.
   */
  async getStudentAttendance(
    p: Principal,
    studentId: string,
    opts: { page?: number; pageSize?: number; from?: string; to?: string } = {},
  ): Promise<{
    records: unknown[];
    page: number;
    pageSize: number;
    total: number;
    from: string | null;
    to: string | null;
  }> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      // An optional window so a reader can ask for one school year out of five
      // rather than paging back through all of them.
      const window = dateWindow(opts.from, opts.to);
      // Filtered on the RECORD's own date now, not through the session. That is
      // what lets Postgres PRUNE to the months in the window instead of reading
      // every partition, and it drops a join from a paged read a parent opens.
      const where = {
        studentId,
        ...(window.from || window.to
          ? { date: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } }
          : {}),
      };

      const [records, total] = await Promise.all([
        tx.attendanceRecord.findMany({
          where,
          // Order by the DAY THE REGISTER IS FOR, not when the row was written.
          // Ordering by createdAt meant correcting a month-old register today put it
          // at the TOP of the history, above this week — so a parent reading down the
          // list saw an out-of-sequence date and no way to tell why.
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          include: { session: { select: { classId: true, date: true } } },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        // COUNTED, not measured off the page. Every under-reported figure found in
        // this codebase came from taking `.length` of a capped list.
        tx.attendanceRecord.count({ where }),
      ]);
      return { records, page, pageSize, total, from: opts.from ?? null, to: opts.to ?? null };
    });
  }

  /**
   * The school's terms, newest first, each flagged with whether its attendance has
   * been rolled up. Feeds the term selector on the class board.
   *
   * Small and unpaged by nature: three terms a year means fifteen rows after five
   * years. It is listed under attendance.read rather than academic.manage because
   * a head teacher needs to CHOOSE a past term without being able to edit the
   * academic calendar.
   */
  async listTerms(p: Principal): Promise<
    Array<{
      id: string;
      name: string;
      sessionName: string;
      startDate: string | null;
      endDate: string | null;
      isCurrent: boolean;
      ended: boolean;
      rolledUp: boolean;
    }>
  > {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const terms = (await tx.term.findMany({
        orderBy: [{ startDate: "desc" }, { sequence: "desc" }],
        select: {
          id: true,
          name: true,
          sequence: true,
          isCurrent: true,
          startDate: true,
          endDate: true,
          session: { select: { name: true } },
        },
      })) as Array<{
        id: string;
        name: string;
        sequence: number;
        isCurrent: boolean;
        startDate: Date | null;
        endDate: Date | null;
        session: { name: string } | null;
      }>;
      if (terms.length === 0) return [];

      // ONE grouped read tells us which terms are rolled up — never one query
      // per term.
      const rolled = (await tx.attendanceTermRollup.groupBy({
        by: ["termId"],
        where: { termId: { in: terms.map((t) => t.id) } },
        _count: { _all: true },
      } as never)) as unknown as Array<{ termId: string }>;
      const have = new Set(rolled.map((r) => r.termId));

      const today = await this.region.todayInTx(tx, p.schoolId);
      return terms.map((t) => ({
        id: t.id,
        name: t.name,
        sessionName: t.session?.name ?? "",
        startDate: t.startDate ? t.startDate.toISOString().slice(0, 10) : null,
        endDate: t.endDate ? t.endDate.toISOString().slice(0, 10) : null,
        isCurrent: t.isCurrent,
        ended: !!t.endDate && t.endDate < today,
        rolledUp: have.has(t.id),
      }));
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
   * Whole days between a register date and TODAY AT THE SCHOOL.
   *
   * The server's UTC day is not the school's day. Using it meant a register was
   * "one day older" than it really was for part of every day west of UTC — enough
   * to push an edit over the 7-day line and into maker-checker a day early.
   */
  private daysSince(date: Date, today: Date): number {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  }

  /** Every marked student must be enrolled in the class. */
  private async assertAllEnrolled(tx: TenantTx, classId: string, records: MarkInput["records"]) {
    // ACTIVE only. A pupil who has left — WITHDRAWN, TRANSFERRED, PROMOTED
    // out or GRADUATED — must not still appear on today's register for a
    // teacher to mark present. Every other reader in the app already filters;
    // these two were missed when enrolment gained a status.
    const enrolled = await tx.enrollment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentId: true },
    });
    const ids = new Set(enrolled.map((e: { studentId: string }) => e.studentId));
    for (const r of records) {
      if (!ids.has(r.studentId)) {
        throw new BadRequestException(`Student ${r.studentId} is not enrolled in this class`);
      }
    }
  }

  /**
   * Write the register (session + records) as ONE bulk upsert. Shared by the
   * direct mark and the maker-checker reactor, so both apply identically. Does
   * NOT re-check the term lock or the 7-day rule — the callers gate that.
   */
  private async applyRegister(
    tx: TenantTx,
    schoolId: string,
    actorId: string,
    classId: string,
    date: Date,
    records: MarkInput["records"],
    meta: { makerChecker: boolean; requestId?: string },
  ) {
    const session = await tx.attendanceSession.upsert({
      where: { classId_date: { classId, date } },
      update: { takenById: actorId },
      create: { schoolId, classId, date, takenById: actorId },
    });
    const now = new Date();
    // `date` is the PARTITION KEY, denormalised from the session. It is taken
    // from the same `date` the session was just upserted on, so the two can
    // never disagree — and because it never changes for a session, a row can
    // never move between partitions.
    const values = records.map(
      (r) => Prisma.sql`(${randomUUID()}::uuid, ${schoolId}::uuid, ${session.id}::uuid, ${r.studentId}::uuid,
           ${r.status}::"AttendanceStatus", ${r.note ?? null}, ${date}::date, ${now}, ${now})`,
    );
    await tx.$executeRaw`
      INSERT INTO "attendance_record" ("id", "schoolId", "sessionId", "studentId", "status", "note", "date", "createdAt", "updatedAt")
      VALUES ${Prisma.join(values)}
      -- Postgres forces the partition key into the unique constraint, so the
      -- conflict target gains "date". Same rule as before: one record per pupil
      -- per register, since the date is fixed by the session.
      ON CONFLICT ("sessionId", "studentId", "date")
      DO UPDATE SET "status" = EXCLUDED."status", "note" = EXCLUDED."note", "updatedAt" = EXCLUDED."updatedAt"
    `;
    await this.audit.record(
      {
        actorId,
        action: meta.makerChecker ? "attendance.amend.apply" : "attendance.mark",
        entity: "attendance_session",
        entityId: session.id,
        schoolId,
        metadata: { classId, count: records.length, ...(meta.requestId ? { workflowRequestId: meta.requestId, makerChecker: true } : {}) },
      },
      tx,
    );
    const alertStudents = records
      .filter((r) => ALERTING_STATUSES.has(r.status))
      .map((r) => ({ studentId: r.studentId, status: r.status }));
    const alerts: { guardianId: string; studentId: string; status: AttendanceStatusValue }[] = [];
    if (alertStudents.length > 0) {
      const links = await tx.parentChild.findMany({
        where: { studentId: { in: alertStudents.map((sx) => sx.studentId) } },
        select: { parentId: true, studentId: true },
      });
      for (const sx of alertStudents) {
        for (const l of links.filter((x: { studentId: string }) => x.studentId === sx.studentId)) {
          alerts.push({ guardianId: l.parentId, studentId: sx.studentId, status: sx.status });
        }
      }
    }
    const loaded = await this.loadSession(tx, session.id);
    return { session: loaded, alerts };
  }

  /**
   * Reject taking a register on a school-declared holiday. Only EXPLICIT holidays
   * block — weekends are left alone so a school that runs Saturday classes is not
   * broken (weekend handling belongs to the teaching-day helpers used in
   * reporting, not to a hard write guard). Fail-open when none are configured.
   *
   * The check is a single INDEXED lookup for a span covering THIS day (uses the
   * (schoolId, startDate) index) — it never loads the whole holiday table. `date`
   * is normalised to midnight UTC so a same-day afternoon still matches a DATE
   * column's midnight endDate.
   */
  private async assertNotHoliday(tx: TenantTx, date: Date): Promise<void> {
    // ONE definition, shared with the ID-card scan desk — the other writer of
    // this table, which asked neither this nor the term lock. See
    // `attendance/register-window.ts`.
    const hit = await holidayOn(tx, date);
    if (hit) {
      throw new BadRequestException(`This date is a school holiday (${hit.name}) — no register is taken. Remove the holiday if this is a school day.`);
    }
  }

  /**
   * The start of the CURRENT term — the lock boundary. A register dated BEFORE
   * this is in a term that has ended and is READ-ONLY. Prefers the explicitly
   * `isCurrent` term; falls back to the term whose date range contains today.
   * Returns null when terms/dates are not configured (fail-open — an unset-up
   * school must never have attendance blocked).
   */
  private async currentTermStart(tx: TenantTx, schoolId: string): Promise<Date | null> {
    // The school's day, so a term boundary flips at midnight WHERE THE SCHOOL IS.
    const today = await this.region.todayInTx(tx, schoolId);
    return currentTermStartInTx(tx, today);
  }

  /**
   * Which of the caller's classes still have NO register for a date.
   *
   * This is the question a school actually asks every morning, and until now there
   * was nowhere to ask it: you had to open each class in turn to discover the one
   * that was never taken. Missing registers are the failure mode that matters —
   * an absence nobody recorded is indistinguishable from a pupil who was present,
   * and by the time anyone notices, the 7-day window has closed and correcting it
   * needs a maker-checker amendment.
   *
   * Scoped exactly like every other read here: whole-school staff see every class,
   * a teacher only the classes they teach.
   */
  /**
   * Attendance BY CLASS for a window — the senior-staff view.
   *
   * One row per class: its attendance rate, how many registers were taken, and who
   * owns it. Senior staff open this to see the school class by class and drill into
   * the one that looks wrong; a school administrator gets the same rows plus the
   * ability to take a register when a supervisor is out.
   *
   * Computed as TWO grouped queries regardless of how many classes exist — thirty
   * classes cost the same as three. It deliberately never loads a roster: the
   * question here is "how is each class doing", and answering it by fetching
   * thousands of pupils to count them in Node is how this page would get slow.
   *
   * `canTake` is returned per row so the UI never has to re-derive the rule and
   * cannot drift from what the server will actually allow.
   */
  async getClassAttendance_Grouped(
    p: Principal,
    opts: { from?: string; to?: string; termId?: string } = {},
  ): Promise<{
    from: string;
    to: string;
    termId: string | null;
    termName: string | null;
    source: "rollup" | "live";
    classes: Array<{
      classId: string;
      className: string;
      supervisorId: string | null;
      supervisorName: string | null;
      canTake: boolean;
      present: number;
      absent: number;
      late: number;
      excused: number;
      total: number;
      ratePct: number | null;
      registersTaken: number;
    }>;
  }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // A named term wins over raw dates: it is what leadership actually asks for
      // ("how was Term 2 of 2021/22"), and it is the only window the rollup can
      // serve, because a rollup row IS a term.
      const term = opts.termId
        ? ((await tx.term.findFirst({
            where: { id: opts.termId },
            select: { id: true, name: true, startDate: true, endDate: true },
          })) as { id: string; name: string; startDate: Date | null; endDate: Date | null } | null)
        : null;
      if (opts.termId && !term) throw new NotFoundException("Term not found");

      // Default window: the current term, so this agrees with the report card and
      // with the analytics page rather than quietly using a different period.
      const termStart = await this.currentTermStart(tx, p.schoolId);
      const asked = dateWindow(opts.from, opts.to);
      const from =
        term?.startDate ??
        (asked.from ? asked.from : (termStart ?? new Date(Date.now() - 30 * 86_400_000)));
      const to = term?.endDate ?? (asked.to ?? new Date());

      // An ENDED term is immutable under the term lock, so its rollup can be read
      // instead of scanning the registers — the whole point of building it. The
      // current term never reads the rollup, however recently it was computed.
      const today = await this.region.todayInTx(tx, p.schoolId);
      const endedTerm = !!term?.endDate && term.endDate < today;

      // Which classes may this caller SEE? Same rule as everywhere else here.
      const visible = this.isSchoolWide(p)
        ? ((await tx.class.findMany({
            orderBy: { name: "asc" },
            select: { id: true, name: true, supervisorId: true },
          })) as Array<{ id: string; name: string; supervisorId: string | null }>)
        : await (async () => {
            const taught = (await tx.classTeacher.findMany({
              where: { teacherId: p.userId },
              select: { classId: true },
            })) as Array<{ classId: string }>;
            const supervised = (await tx.class.findMany({
              where: { supervisorId: p.userId },
              select: { id: true },
            })) as Array<{ id: string }>;
            const ids = [...new Set([...taught.map((x) => x.classId), ...supervised.map((x) => x.id)])];
            if (ids.length === 0) return [] as Array<{ id: string; name: string; supervisorId: string | null }>;
            return (await tx.class.findMany({
              where: { id: { in: ids } },
              orderBy: { name: "asc" },
              select: { id: true, name: true, supervisorId: true },
            })) as Array<{ id: string; name: string; supervisorId: string | null }>;
          })();
      const base = {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        termId: term?.id ?? null,
        termName: term?.name ?? null,
      };
      if (visible.length === 0) {
        return { ...base, source: "live" as const, classes: [] };
      }
      const classIds = visible.map((c) => c.id);

      // An ended term reads its precomputed per-class totals; anything else groups
      // the registers themselves. Same shape either way, so nothing downstream
      // knows or cares which ran — and a term that has ended but has not been
      // rolled up yet simply falls through to the live path below.
      const rolled = endedTerm
        ? ((await tx.attendanceTermRollup.groupBy({
            by: ["classId"],
            where: { termId: term!.id, classId: { in: classIds } },
            _sum: { present: true, absent: true, late: true, excused: true, total: true },
          } as never)) as unknown as Array<{
            classId: string;
            _sum: { present: number | null; absent: number | null; late: number | null; excused: number | null; total: number | null };
          }>)
        : [];
      const useRollup = rolled.length > 0;

      // ONE pivot over the window for every visible class, plus one count of the
      // registers actually taken. Never a query per class.
      const [stats, registers, supervisors] = await Promise.all([
        useRollup
          ? Promise.resolve(
              rolled.map((r) => ({
                classId: r.classId,
                present: r._sum.present ?? 0,
                absent: r._sum.absent ?? 0,
                late: r._sum.late ?? 0,
                excused: r._sum.excused ?? 0,
                total: r._sum.total ?? 0,
              })),
            )
          : (tx.$queryRaw`
          SELECT s."classId",
                 count(*) FILTER (WHERE r.status = 'PRESENT')::int AS present,
                 count(*) FILTER (WHERE r.status = 'ABSENT')::int  AS absent,
                 count(*) FILTER (WHERE r.status = 'LATE')::int    AS late,
                 count(*) FILTER (WHERE r.status = 'EXCUSED')::int AS excused,
                 count(*)::int                                     AS total
          FROM attendance_record r
          JOIN attendance_session s ON s.id = r."sessionId"
          WHERE r."schoolId" = ${p.schoolId}::uuid
            AND s."classId" = ANY(ARRAY[${Prisma.join(classIds)}]::uuid[])
            AND s.date BETWEEN ${from}::date AND ${to}::date
          GROUP BY s."classId"
        ` as Promise<Array<{ classId: string; present: number; absent: number; late: number; excused: number; total: number }>>),
        tx.attendanceSession.groupBy({
          by: ["classId"],
          where: { classId: { in: classIds }, date: { gte: from, lte: to } },
          _count: { _all: true },
        } as never) as unknown as Promise<Array<{ classId: string; _count: { _all: number } }>>,
        (async () => {
          const ids = [...new Set(visible.map((c) => c.supervisorId).filter((x): x is string => !!x))];
          if (ids.length === 0) return [] as Array<{ id: string; name: string }>;
          return (await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
            id: string;
            name: string;
          }>;
        })(),
      ]);

      const statBy = new Map(stats.map((s) => [s.classId, s]));
      const regBy = new Map(registers.map((r) => [r.classId, r._count._all]));
      const supBy = new Map(supervisors.map((u) => [u.id, u.name]));
      const cover = p.roles.some((r) => REGISTER_COVER_ROLES.has(r));

      return {
        ...base,
        source: useRollup ? ("rollup" as const) : ("live" as const),
        classes: visible.map((c) => {
          const s = statBy.get(c.id) ?? { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
          // LATE and EXCUSED count as attending — the pupil was in school, or the
          // absence was authorised. Same rule as the report card.
          // ONE definition, shared with the report card — see attendanceRatePct.
          // This used to add `excused`, so the board and the printed card gave a
          // pupil two different percentages.
          const ratePct = attendanceRatePct(s);
          return {
            classId: c.id,
            className: c.name,
            supervisorId: c.supervisorId,
            supervisorName: c.supervisorId ? supBy.get(c.supervisorId) ?? null : null,
            // Exactly the server's own rule, so the UI cannot offer a button the
            // API will refuse.
            canTake: cover || (!!c.supervisorId && c.supervisorId === p.userId),
            ...s,
            ratePct,
            registersTaken: regBy.get(c.id) ?? 0,
          };
        }),
      };
    });
  }

  async getRegisterStatus(
    p: Principal,
    dateStr?: string,
  ): Promise<{ date: string; classes: { classId: string; className: string; taken: boolean; marked: number; enrolled: number }[] }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // dayUtc returns a TIMESTAMP, not a Date — wrap it so the column comparison
      // gets a Date and the label is UTC-midnight, matching the @db.Date column.
      // Defaults to the SCHOOL's today, not the server's.
      const date = dateStr
        ? new Date(`${dateStr}T00:00:00.000Z`)
        : await this.region.todayInTx(tx, p.schoolId);
      const iso = date.toISOString().slice(0, 10);

      // The caller's classes, by the same relationship rule as the rest of the file.
      const classes = this.isSchoolWide(p)
        ? ((await tx.class.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })) as Array<{ id: string; name: string }>)
        : await (async () => {
            const mine = (await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } })) as Array<{ classId: string }>;
            const ids = [...new Set(mine.map((m) => m.classId))];
            if (ids.length === 0) return [] as Array<{ id: string; name: string }>;
            return (await tx.class.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" }, select: { id: true, name: true } })) as Array<{
              id: string;
              name: string;
            }>;
          })();
      if (classes.length === 0) return { date: iso, classes: [] };

      const classIds = classes.map((c) => c.id);
      // Three BATCHED queries regardless of class count — sessions for the day, a
      // grouped count of marks, and a grouped count of enrolments. Never per class.
      const sessions = (await tx.attendanceSession.findMany({
        where: { classId: { in: classIds }, date },
        select: { id: true, classId: true },
      })) as Array<{ id: string; classId: string }>;
      const sessionByClass = new Map(sessions.map((s) => [s.classId, s.id]));
      const [markCounts, enrolCounts] = await Promise.all([
        sessions.length
          ? (tx.attendanceRecord.groupBy({
              by: ["sessionId"],
              where: { sessionId: { in: sessions.map((s) => s.id) } },
              _count: { _all: true },
            } as never) as unknown as Promise<Array<{ sessionId: string; _count: { _all: number } }>>)
          : Promise.resolve([] as Array<{ sessionId: string; _count: { _all: number } }>),
        // The EXPECTED count on the daily overview. Unfiltered it counts
        // pupils who have left, so a fully-marked register reads "28 of 32"
        // and looks like the teacher forgot four children.
        tx.enrollment.groupBy({ by: ["classId"], where: { classId: { in: classIds }, status: "ACTIVE" }, _count: { _all: true } } as never) as unknown as Promise<
          Array<{ classId: string; _count: { _all: number } }>
        >,
      ]);
      const markBySession = new Map(markCounts.map((m) => [m.sessionId, m._count._all]));
      const enrolByClass = new Map(enrolCounts.map((e) => [e.classId, e._count._all]));

      return {
        date: iso,
        classes: classes.map((c) => {
          const sessionId = sessionByClass.get(c.id);
          return {
            classId: c.id,
            className: c.name,
            taken: !!sessionId,
            marked: sessionId ? markBySession.get(sessionId) ?? 0 : 0,
            enrolled: enrolByClass.get(c.id) ?? 0,
          };
        }),
      };
    });
  }

  /**
   * A student's attendance TOTALS for the current term.
   *
   * The history list answers "what happened on the 12th"; nobody reads 200 rows to
   * work out whether a child is attending. This is one grouped aggregate, term-
   * scoped the same way the report card is (the `isCurrent` term's window), so the
   * figure a parent sees on this page matches the figure printed on the report.
   */
  async getStudentSummary(
    p: Principal,
    studentId: string,
  ): Promise<{ from: string | null; to: string | null; present: number; absent: number; late: number; excused: number; total: number; percent: number | null }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      await this.assertCanAccessStudent(tx, p, studentId);
      const term = (await tx.term.findFirst({ where: { isCurrent: true }, select: { startDate: true, endDate: true } })) as
        | { startDate: Date | null; endDate: Date | null }
        | null;
      // No configured term: fall back to ALL history rather than reporting zero,
      // which would read as "never attended".
      const window =
        term?.startDate && term.endDate ? { gte: term.startDate, lte: term.endDate } : undefined;

      const grouped = (await tx.attendanceRecord.groupBy({
        by: ["status"],
        where: { studentId, ...(window ? { session: { date: window } } : {}) },
        _count: { _all: true },
      } as never)) as unknown as Array<{ status: string; _count: { _all: number } }>;

      const n = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
      const present = n("PRESENT");
      const absent = n("ABSENT");
      const late = n("LATE");
      const excused = n("EXCUSED");
      const total = present + absent + late + excused;
      return {
        from: term?.startDate ? term.startDate.toISOString().slice(0, 10) : null,
        to: term?.endDate ? term.endDate.toISOString().slice(0, 10) : null,
        present,
        absent,
        late,
        excused,
        total,
        // LATE counts as attending — the pupil WAS in school. EXCUSED does not:
        // the pupil was absent and the school accepted the reason.
        //
        // // GOTCHA: this comment used to justify including late "so it does not
        // contradict the report card", on a line that also added `excused` —
        // which the report card never has. Measured on one pupil over a term
        // (54 present, 9 late, 2 absent, 5 excused of 70) the card printed 90%
        // and this returned 97%.
        percent: attendanceRatePct({ present, late, absent, excused }),
      };
    });
  }

  /** The lock boundary for the UI: dates before this are read-only. */
  async getTermLock(p: Principal): Promise<{ lockBeforeDate: string | null }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const start = await this.currentTermStart(tx, p.schoolId);
      return { lockBeforeDate: start ? start.toISOString().slice(0, 10) : null };
    });
  }

  /**
   * VIEW a class's register. Broad: whole-school staff, anyone who teaches the class,
   * and its supervisor. Unchanged — senior staff must be able to see every register,
   * which is the whole point of the class-grouped view.
   */
  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true, supervisorId: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.isSchoolWide(p)) return;
    if (cls.supervisorId && cls.supervisorId === p.userId) return;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    // SECURITY: 404 (not 403) — don't reveal a class the caller can't see.
    if (!teaches) throw new NotFoundException("Class not found");
  }

  /**
   * TAKE or correct a class's register. Deliberately NARROWER than viewing it.
   *
   * The register is a legal record of where a child was, signed by the person who
   * actually looked at the room. So the right to write it follows RESPONSIBILITY for
   * the class, not seniority:
   *
   *   - the class SUPERVISOR (form teacher) — their own class, and only theirs
   *   - school_admin / super_admin — any class, to cover an absent supervisor
   *
   * Everyone else views. That removes write from roles that had it before —
   * principal, head teacher, junior_admin, and subject teachers who happen to teach
   * the class — which is the point: a subject teacher seeing a class for one period
   * is not the person who should be recording whether a child was in school that
   * day, and a principal recording it for a class they never entered is a record
   * nobody can stand behind.
   *
   * 403, not 404, when the caller can SEE the class but may not write it: hiding a
   * class they are looking at would read as a bug rather than a rule.
   */
  private async assertCanTakeRegister(tx: TenantTx, p: Principal, classId: string) {
    const cls = (await tx.class.findFirst({
      where: { id: classId },
      select: { id: true, name: true, supervisorId: true },
    })) as { id: string; name: string; supervisorId: string | null } | null;
    if (!cls) throw new NotFoundException("Class not found");
    if (p.roles.some((r) => REGISTER_COVER_ROLES.has(r))) return;
    if (cls.supervisorId && cls.supervisorId === p.userId) return;

    // Can they at least SEE it? If not, keep the 404 so nothing is disclosed.
    await this.assertTeacherOfClass(tx, p, classId);
    throw new ForbiddenException(
      `Only ${cls.name}'s supervisor takes its register — ask a school administrator to cover it`,
    );
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
      // SECURITY: ACTIVE only. Without the status filter this asked "was this
      // pupil EVER in a class I teach", so a teacher kept access to a pupil who
      // had since withdrawn, transferred or been promoted out — indefinitely,
      // and to their records rather than merely their name. Proven live: a
      // pupil was set to WITHDRAWN and their old teacher still fetched a signed
      // download URL for their report card. Whole-school staff are unaffected,
      // so the school can still produce a departed pupil's paperwork.
      const enrolled = await tx.enrollment.findFirst({
        where: { studentId, status: "ACTIVE", classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { id: true },
      });
      if (enrolled) return;
    }
    throw new NotFoundException("Student not found");
  }
}
