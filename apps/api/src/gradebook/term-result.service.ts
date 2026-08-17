// =============================================================================
// TermResultService — term-weighted subject grading (report-card grades)
// =============================================================================
// Distinct from GradebookService (which grades integrity submissions). Here a
// SUBJECT TEACHER enters four component scores (exam/midterm/assignment/note)
// for each student offering their subject in a class, per term; the weighted
// total is recomputed server-side from @sms/types (never trusted from the
// client). Students/parents read PUBLISHED results only (their own / children).
//
// Relationship scoping (coarse grade.read/grade.write gate is in the guard):
//   - write: the class-subject's ASSIGNED teacher (ClassSubjectTeacher) or a
//     school-wide role. A random teacher cannot grade another's subject.
//   - roster read: same as write (you grade what you can see).
//   - report read: student→self, parent→children (PUBLISHED only); staff who
//     teach/supervise the class or are school-wide see all statuses.
// Cross-tenant / not-visible -> 404 (never 403). Every write audit-logged.
// SECURITY (Golden Rule #8): a grade is only ever a manual teacher decision.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import PDFDocument from "pdfkit";
import {
  computeTermSubjectGrade,
  type GradingPolicy,
  averageOf,
  gradeComponentMax,
  GRADE_COMPONENTS,
  GRADE_PUBLISH_CHAIN,
  type GradeComponentKey,
  type GradingRosterDto,
  type SubjectResultDto,
  type StudentSessionReportDto,
  type StudentTermReportDto,
  type SubjectSessionSummaryDto,
  type TermSubjectRowDto,
  type ClassBroadsheetDto,
  type SubjectAnalyticsDto,
  resolveGradeBands,
  gradeLetter,
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
import { SchoolRegionService } from "../foundation/school-region.service";

// Who may grade ANY class-subject in the school. `principal` was missing while
// holding `grade.write` — a permission whose rows were all 404. Every comparable
// module (attendance, SIS, timetable, CBT, and the report card built on THIS
// data) already treats a principal as school-wide.
const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal"]);

// Who may READ any class's marks. Strictly wider, and deliberately a separate
// set: `board` is read-only oversight and `head_teacher` a stage-1 approver, and
// both hold `grade.read`. Folding them into the set above would have handed them
// grade WRITING, since one set gated both — which is why the read grants had
// been left dead rather than honoured.
const READ_WIDE_ROLES = new Set([...SCHOOL_WIDE_ROLES, "board", "head_teacher", "junior_admin"]);

interface ComponentInput {
  exam?: number | null;
  midterm?: number | null;
  assignment?: number | null;
  classNote?: number | null;
}

interface UpsertResultInput extends ComponentInput {
  termId: string;
  classId: string;
  subjectId: string;
  studentId: string;
}

@Injectable()
export class TermResultService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
    private readonly region: SchoolRegionService,
  ) {
    // Maker-checker reactor: when the head-teacher→principal GRADE_PUBLISH
    // chain finalizes, flip the batch in the SAME tenant tx as the transition
    // (atomic). APPROVED → PUBLISHED (families can now see them); REJECTED →
    // back to DRAFT so the teacher can correct and resubmit. Idempotent: only
    // PENDING_APPROVAL rows move, so a replay is a no-op.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "GRADE_PUBLISH") return;
      const pl = req.payload as { classId?: string; subjectId?: string; termId?: string } | null;
      if (!pl?.classId || !pl.subjectId || !pl.termId) return;
      await tx.subjectResult.updateMany({
        where: { classId: pl.classId, subjectId: pl.subjectId, termId: pl.termId, status: "PENDING_APPROVAL" },
        data: { status: req.state === "APPROVED" ? "PUBLISHED" : "DRAFT" },
      });
      await this.audit.record(
        {
          actorId: req.initiatorId,
          action: req.state === "APPROVED" ? "gradebook.term.publish.approved" : "gradebook.term.publish.rejected",
          entity: "subject_result",
          entityId: `${pl.classId}:${pl.subjectId}:${pl.termId}`,
          schoolId: req.schoolId,
          metadata: { requestId: req.id },
        },
        tx,
      );
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /** School-wide for READS only. Never call this on a write path. */
  private isReadWide(p: Principal): boolean {
    return p.roles.some((r) => READ_WIDE_ROLES.has(r));
  }

  /** The students who take `subjectId` in this class+term. APPROVED subject
   *  selections (Phase-2 maker-checker) are authoritative when any exist for
   *  the class+term; otherwise every ACTIVE enrollment (selection-less schools). */
  private async subjectTakers(
    tx: TenantTx,
    classId: string,
    termId: string,
    subjectId: string,
  ): Promise<string[]> {
    const selections = await tx.subjectSelection.findMany({
      where: { classId, termId, status: "APPROVED" },
      select: { studentId: true, subjectIds: true },
    });
    if (selections.length > 0) {
      return selections
        .filter((s) => ((s.subjectIds as string[]) ?? []).includes(subjectId))
        .map((s) => s.studentId);
    }
    const enrollments = await tx.enrollment.findMany({
      where: { classId, status: "ACTIVE" },
      select: { studentId: true },
    });
    return enrollments.map((e) => e.studentId);
  }

  /** May the caller grade this class-subject? Assigned teacher or school-wide. */
  private async canGradeClassSubject(
    tx: TenantTx,
    p: Principal,
    classId: string,
    subjectId: string,
  ): Promise<boolean> {
    if (this.isSchoolWide(p)) return true;
    const offering = await tx.classSubjectTeacher.findFirst({
      where: { classId, subjectId, teacherId: p.userId },
      select: { id: true },
    });
    return !!offering;
  }

  /**
   * Serialise every write to ONE (session, term, subject, student) result row.
   *
   * Three code paths write that row — a CBT paper's exam total, an LMS/assessment
   * aggregate, and a teacher typing marks — and each does a READ-MODIFY-WRITE:
   * it reads the three components it is NOT setting so it can merge them back.
   * Two of them running at once therefore lose one of the two marks. Proven at
   * the DB layer with the real statements the service issues:
   *
   *     before: exam 46, assignment 8
   *     CBT push reads assignment=8, LMS push reads exam=46
   *     LMS commits (exam 46, assignment 10) -> CBT commits (exam 55, assignment 8)
   *     after:  exam 55, assignment 8      <- the LMS mark is gone
   *
   * and both presses reported success. It is the lost-update shape the hostel,
   * meeting and library claims already guard against, on the one table where the
   * consequence is a mark missing from a child's report card.
   *
   * An ADVISORY lock rather than SELECT ... FOR UPDATE, because the row often
   * does not exist yet: the first press of the term CREATES it, and two
   * concurrent creates race through the unique index into ON CONFLICT DO UPDATE,
   * where the loser writes its own all-null view of the other components. There
   * is nothing to lock until it is too late. The advisory lock is keyed on the
   * identity of the row rather than on the row, is transaction-scoped so it
   * releases on commit or rollback, and costs a hash — a collision merely makes
   * two unrelated writes take turns.
   */
  private async lockResultRow(
    tx: TenantTx,
    key: { sessionId: string; termId: string; subjectId: string; studentId: string },
  ): Promise<void> {
    const id = `${key.sessionId}:${key.termId}:${key.subjectId}:${key.studentId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
  }

  /** Recompute total/grade from components; validate each mark against ITS OWN
   *  maximum so a teacher can't award more than a component is worth.
   *
   *  The maxima come from the SCHOOL's weighting, not a platform constant: a school
   *  that weights coursework at 30 must accept a 30-mark assignment, and one that
   *  weights it at 10 must still refuse an 11. */
  private applyComponents(c: ComponentInput, policy?: GradingPolicy) {
    const comps = policy?.components ?? GRADE_COMPONENTS;
    const label: Record<GradeComponentKey, string> =
      Object.fromEntries(comps.map((g) => [g.key, g.label])) as Record<GradeComponentKey, string>;
    for (const key of comps.map((g) => g.key)) {
      const v = c[key];
      if (v === null || v === undefined) continue;
      const max = comps.find((g) => g.key === key)?.max ?? gradeComponentMax(key);
      if (v < 0 || v > max) {
        throw new BadRequestException(`${label[key]} must be between 0 and ${max}`);
      }
    }
    const components = {
      exam: c.exam ?? null,
      midterm: c.midterm ?? null,
      assignment: c.assignment ?? null,
      classNote: c.classNote ?? null,
    };
    const anyEntered = Object.values(components).some((v) => v !== null);
    const { total, grade, complete } = computeTermSubjectGrade(components, policy?.components, resolveGradeBands(policy));
    return {
      ...components,
      // total/grade only meaningful once at least one component is entered.
      total: anyEntered ? total : null,
      grade: anyEntered ? grade : null,
      // Carried, not discarded. A missing component counts as zero in the
      // total, so without this an interim mark and a final one are the same
      // number — and the report card that reaches the family cannot tell a
      // pupil who scored 24 from one whose exam has not been marked.
      complete,
    };
  }

  /**
   * Recompute a row's total from its four components AT READ TIME, so a report is
   * correct even if the denormalised `total` column was written under an older
   * scoring rule (or left stale). Null total when nothing is entered yet.
   *
   * THE POLICY IS NOT OPTIONAL IN PRACTICE. It was declared optional and then
   * never passed by any of the four callers, so every read — the roster, the
   * broadsheet, the session report and the report card behind it — recomputed on
   * the PLATFORM defaults while the write path had used the SCHOOL's. A school
   * with its own weighting or letter scale saw one set of numbers when a mark was
   * saved and another whenever it was read back.
   */
  private recomputeTotal(
    row: {
      exam: number | null;
      midterm: number | null;
      assignment: number | null;
      classNote: number | null;
    },
    /** The SCHOOL's weighting. Omitted = the platform default, which is what every
     *  school already live uses. */
    policy?: GradingPolicy,
  ): { total: number | null; grade: string | null; complete: boolean } {
    const anyEntered = [row.exam, row.midterm, row.assignment, row.classNote].some((v) => v !== null);
    if (!anyEntered) return { total: null, grade: null, complete: false };
    const { total, grade, complete } = computeTermSubjectGrade(
      {
        exam: row.exam,
        midterm: row.midterm,
        assignment: row.assignment,
        classNote: row.classNote,
      },
      policy?.components,
      // The school's own letter scale. This is now TRUE of every subject grade a
      // family reads, and of the term average beside them — the term report
      // states its own `averageGrade` rather than leaving the report card to
      // derive one. It was written as if it were already true while `policy`
      // arrived undefined at every call site, which is how the divergence went
      // unnoticed: the comment described the intent, not the wiring.
      resolveGradeBands(policy),
    );
    return { total, grade, complete };
  }

  private toResultDto(
    policy: GradingPolicy | undefined,
    row: {
      id: string;
      sessionId: string;
      termId: string;
      classId: string;
      subjectId: string;
      studentId: string;
      exam: number | null;
      midterm: number | null;
      assignment: number | null;
      classNote: number | null;
      total: number | null;
      grade: string | null;
      status: string;
      gradedById: string | null;
      gradedAt: Date;
    },
    subjectName: string,
    studentName: string,
  ): SubjectResultDto {
    const { total, grade, complete } = this.recomputeTotal(row, policy);
    return {
      id: row.id,
      sessionId: row.sessionId,
      termId: row.termId,
      classId: row.classId,
      subjectId: row.subjectId,
      subjectName,
      studentId: row.studentId,
      studentName,
      exam: row.exam,
      midterm: row.midterm,
      assignment: row.assignment,
      classNote: row.classNote,
      total,
      grade,
      status: row.status,
      gradedById: row.gradedById,
      gradedAt: row.gradedAt,
      complete,
    };
  }

  // ---------------------------------------------------------------------------
  // Subject-teacher grading roster
  // ---------------------------------------------------------------------------
  /** Students offering `subjectId` in `classId` for `termId`, with their current
   *  SubjectResult. Caller must be able to grade the class-subject (else 404). */
  async getGradingRoster(
    p: Principal,
    args: { classId: string; subjectId: string; termId: string },
  ): Promise<GradingRosterDto> {
    const { classId, subjectId, termId } = args;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The teacher's own roster must show the same numbers the mark was saved
      // with — the school's weighting, not the platform's.
      const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const term = await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, name: true, sessionId: true },
      });
      const klass = await tx.class.findFirst({
        where: { id: classId },
        select: { id: true, name: true },
      });
      const subject = await tx.subject.findFirst({
        where: { id: subjectId },
        select: { id: true, name: true },
      });
      // SECURITY: hide existence if any referent is missing or caller can't grade.
      if (!term || !klass || !subject) throw new NotFoundException("Not found");
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) {
        throw new NotFoundException("Not found");
      }

      // Who offers this subject this term? When APPROVED subject selections
      // exist for the class+term, THEY are the source of truth (the student's
      // approved pick must include this subject). Otherwise fall back to all
      // ACTIVE enrollments so schools not using selections still work.
      const studentIds = await this.subjectTakers(tx, classId, termId, subjectId);
      // Prisma resolves `{ in: [] }` to an empty result, so no length guard needed.
      const [students, profiles, results] = await Promise.all([
        tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } }),
        tx.studentProfile.findMany({
          where: { studentId: { in: studentIds } },
          select: { studentId: true, admissionNumber: true },
        }),
        tx.subjectResult.findMany({ where: { termId, subjectId, studentId: { in: studentIds } } }),
      ]);
      const nameById = new Map(students.map((s) => [s.id, s.name]));
      const admById = new Map(profiles.map((pr) => [pr.studentId, pr.admissionNumber]));
      const resultByStudent = new Map(results.map((r) => [r.studentId, r]));

      const roster = studentIds
        .map((sid) => ({
          studentId: sid,
          studentName: nameById.get(sid) ?? "Unknown",
          admissionNumber: admById.get(sid) ?? null,
          result: resultByStudent.has(sid)
            ? this.toResultDto(grading, resultByStudent.get(sid)!, subject.name, nameById.get(sid) ?? "Unknown")
            : null,
          position: null as number | null,
        }))
        .sort((a, b) => a.studentName.localeCompare(b.studentName));

      // Rank within THIS subject by total (highest first); ties share a position
      // (standard competition ranking). Ungraded students stay unranked (null).
      const ranked = roster
        .filter((r) => r.result?.total != null)
        .sort((a, b) => (b.result!.total as number) - (a.result!.total as number));
      let position = 0;
      let seen = 0;
      let prev: number | null = null;
      for (const r of ranked) {
        seen += 1;
        const total = r.result!.total as number;
        if (prev === null || total !== prev) {
          position = seen;
          prev = total;
        }
        r.position = position;
      }

      return {
        classId,
        className: klass.name,
        subjectId,
        subjectName: subject.name,
        sessionId: term.sessionId,
        termId,
        termName: term.name,
        students: roster,
        // The console previews totals in the browser; it now previews with THIS,
        // the same policy the save will use, instead of the platform defaults.
        components: grading.components.map((c) => ({ ...c })),
        bands: [...resolveGradeBands(grading)],
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Grade one student (upsert component scores)
  // ---------------------------------------------------------------------------
  async upsertResult(p: Principal, input: UpsertResultInput): Promise<SubjectResultDto> {
    const { termId, classId, subjectId, studentId } = input;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({
        where: { id: termId },
        select: { id: true, sessionId: true },
      });
      const subject = await tx.subject.findFirst({
        where: { id: subjectId },
        select: { id: true, name: true },
      });
      if (!term || !subject) throw new NotFoundException("Not found");
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) {
        throw new NotFoundException("Not found");
      }
      // The student must actually be enrolled in this class (no grading a
      // stranger into a class-subject they don't take).
      const enrolled = await tx.enrollment.findFirst({
        where: { classId, studentId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!enrolled) throw new NotFoundException("Student is not enrolled in this class");
      // …and when approved subject selections govern this class+term, their
      // approved pick must include this subject.
      const takers = await this.subjectTakers(tx, classId, termId, subjectId);
      if (!takers.includes(studentId)) {
        throw new NotFoundException("This student does not offer this subject for the term");
      }
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { id: true, name: true } });
      if (!student) throw new NotFoundException("Not found");

      // The manual path writes the SAME row the two automatic pushes do, and
      // reads it first for the same reason, so it takes the same lock. A teacher
      // typing a class note while a CBT push lands otherwise loses one of them.
      await this.lockResultRow(tx, { sessionId: term.sessionId, termId, subjectId, studentId });

      // Publish is maker-checker (head teacher → principal), so the batch must
      // stay stable while under review, and an already-published grade can't be
      // silently changed behind the approvers' backs.
      const existing = await tx.subjectResult.findFirst({
        where: { sessionId: term.sessionId, termId, subjectId, studentId },
        select: { status: true },
      });
      if (existing?.status === "PENDING_APPROVAL") {
        throw new ConflictException(
          "These grades are awaiting head-teacher/principal approval and can't be edited until the review completes.",
        );
      }
      // SECURITY: editing a PUBLISHED grade reverts it to DRAFT — the change is
      // hidden from families again until it goes back through the publish chain.
      // Named for what it means: `unpublished` read as "was not published",
      // which is the opposite.
      const revertedFromPublished = existing?.status === "PUBLISHED";

      const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const scored = this.applyComponents(input, grading);
      // `complete` is COMPUTED, not stored — there is no such column, and
      // spreading it into the write makes Prisma reject the whole upsert. It is
      // derived on every read from the four components, which is the only way it
      // can stay true when a component is filled in later.
      const { complete: _complete, ...persisted } = scored;
      const data = { ...persisted, gradedById: p.userId, gradedAt: new Date() };
      const row = await tx.subjectResult.upsert({
        where: { sessionId_termId_subjectId_studentId: { sessionId: term.sessionId, termId, subjectId, studentId } },
        create: { schoolId: p.schoolId, sessionId: term.sessionId, termId, classId, subjectId, studentId, ...data },
        // classId can change if the student moved classes mid-term — keep it current.
        update: { classId, ...data, ...(revertedFromPublished ? { status: "DRAFT" } : {}) },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.grade.set",
          entity: "subject_result",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { termId, subjectId, studentId, total: row.total, status: row.status, revertedFromPublished },
        },
        tx,
      );
      return this.toResultDto(grading, row, subject.name, student.name);
    });
  }

  /** Throw 404 unless `p` may grade this class-subject. Public wrapper over the
   *  private scope check so the LMS "pull scores into the gradebook" flow gates
   *  its read on the exact same rule as grading. */
  async ensureCanGrade(p: Principal, classId: string, subjectId: string): Promise<void> {
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) {
        throw new NotFoundException("Not found");
      }
    });
  }

  /** Set ONLY the "assignment" CA component on a student's SubjectResult,
   *  MERGING it with the existing exam/midterm/class-note marks (so pulling an
   *  LMS score never wipes marks a teacher already entered). Runs the full
   *  grading guard set (scope, enrolment, subject-taker, maker-checker) and
   *  leaves the row as DRAFT for the normal publish chain. Used by the LMS
   *  "pull scores into the report card" flow. */
  /**
   * Merge a CBT paper's total into the EXAM component, leaving the other three
   * components untouched and the row DRAFT for the normal publish chain. This is
   * the "record exam scores to the gradesheet" path — the exact mirror of
   * applyAssignmentComponent, so both pushes behave identically.
   */
  async applyExamComponent(
    p: Principal,
    input: { classId: string; subjectId: string; termId: string; studentId: string; exam: number },
  ): Promise<{ result: SubjectResultDto; revertedFromPublished: boolean }> {
    const { classId, subjectId, termId, studentId, exam } = input;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true, sessionId: true } });
      const subject = await tx.subject.findFirst({ where: { id: subjectId }, select: { id: true, name: true } });
      if (!term || !subject) throw new NotFoundException("Not found");
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) throw new NotFoundException("Not found");
      const enrolled = await tx.enrollment.findFirst({
        where: { classId, studentId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!enrolled) throw new NotFoundException("Student is not enrolled in this class");
      const takers = await this.subjectTakers(tx, classId, termId, subjectId);
      if (!takers.includes(studentId)) {
        throw new NotFoundException("This student does not offer this subject for the term");
      }
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { id: true, name: true } });
      if (!student) throw new NotFoundException("Not found");
      await this.lockResultRow(tx, { sessionId: term.sessionId, termId, subjectId, studentId });
      const existing = await tx.subjectResult.findFirst({
        where: { sessionId: term.sessionId, termId, subjectId, studentId },
        select: { status: true, midterm: true, assignment: true, classNote: true },
      });
      if (existing?.status === "PENDING_APPROVAL") {
        throw new ConflictException(
          "These grades are awaiting head-teacher/principal approval and can't be edited until the review completes.",
        );
      }
      // Changing a mark on a PUBLISHED result sends it back to DRAFT for
      // re-approval — correct, and invisible: that subject comes off every live
      // report card until the head teacher and principal pass it again. The old
      // name for this said `unpublished`, which reads as "was not published" and
      // is the opposite of what it means. It is now reported to the caller so
      // whoever pressed the button can be told.
      const revertedFromPublished = existing?.status === "PUBLISHED";
      // MERGE: keep the other three components; only the exam slice changes.
      const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const scored = this.applyComponents(
        {
          exam,
          midterm: existing?.midterm ?? null,
          assignment: existing?.assignment ?? null,
          classNote: existing?.classNote ?? null,
        },
        grading,
      );
      // `complete` is COMPUTED, not stored — there is no such column, and
      // spreading it into the write makes Prisma reject the whole upsert. It is
      // derived on every read from the four components, which is the only way it
      // can stay true when a component is filled in later.
      const { complete: _complete, ...persisted } = scored;
      const data = { ...persisted, gradedById: p.userId, gradedAt: new Date() };
      const row = await tx.subjectResult.upsert({
        where: { sessionId_termId_subjectId_studentId: { sessionId: term.sessionId, termId, subjectId, studentId } },
        create: { schoolId: p.schoolId, sessionId: term.sessionId, termId, classId, subjectId, studentId, ...data },
        update: { classId, ...data, ...(revertedFromPublished ? { status: "DRAFT" } : {}) },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.exam.applied",
          entity: "subject_result",
          entityId: row.id,
          schoolId: p.schoolId,
          // The same facts the LMS push records. They diverged, and the one
          // missing them was the one that can withdraw a published result.
          metadata: { subjectId, studentId, termId, exam, total: row.total, status: row.status, revertedFromPublished },
        },
        tx,
      );
      return { result: this.toResultDto(grading, row, subject.name, student.name), revertedFromPublished };
    });
  }

  async applyAssignmentComponent(
    p: Principal,
    input: { classId: string; subjectId: string; termId: string; studentId: string; assignment: number },
  ): Promise<{ result: SubjectResultDto; revertedFromPublished: boolean }> {
    const { classId, subjectId, termId, studentId, assignment } = input;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true, sessionId: true } });
      const subject = await tx.subject.findFirst({ where: { id: subjectId }, select: { id: true, name: true } });
      if (!term || !subject) throw new NotFoundException("Not found");
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) throw new NotFoundException("Not found");
      const enrolled = await tx.enrollment.findFirst({
        where: { classId, studentId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!enrolled) throw new NotFoundException("Student is not enrolled in this class");
      const takers = await this.subjectTakers(tx, classId, termId, subjectId);
      if (!takers.includes(studentId)) {
        throw new NotFoundException("This student does not offer this subject for the term");
      }
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { id: true, name: true } });
      if (!student) throw new NotFoundException("Not found");

      await this.lockResultRow(tx, { sessionId: term.sessionId, termId, subjectId, studentId });
      const existing = await tx.subjectResult.findFirst({
        where: { sessionId: term.sessionId, termId, subjectId, studentId },
        select: { status: true, exam: true, midterm: true, classNote: true },
      });
      if (existing?.status === "PENDING_APPROVAL") {
        throw new ConflictException(
          "These grades are awaiting head-teacher/principal approval and can't be edited until the review completes.",
        );
      }
      const revertedFromPublished = existing?.status === "PUBLISHED";
      // MERGE: keep the other three components; only the assignment slice changes.
      const grading = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const scored = this.applyComponents(
        {
          exam: existing?.exam ?? null,
          midterm: existing?.midterm ?? null,
          assignment,
          classNote: existing?.classNote ?? null,
        },
        grading,
      );
      // `complete` is COMPUTED, not stored — there is no such column, and
      // spreading it into the write makes Prisma reject the whole upsert. It is
      // derived on every read from the four components, which is the only way it
      // can stay true when a component is filled in later.
      const { complete: _complete, ...persisted } = scored;
      const data = { ...persisted, gradedById: p.userId, gradedAt: new Date() };
      const row = await tx.subjectResult.upsert({
        where: { sessionId_termId_subjectId_studentId: { sessionId: term.sessionId, termId, subjectId, studentId } },
        create: { schoolId: p.schoolId, sessionId: term.sessionId, termId, classId, subjectId, studentId, ...data },
        update: { classId, ...data, ...(revertedFromPublished ? { status: "DRAFT" } : {}) },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.grade.lms_applied",
          entity: "subject_result",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { termId, subjectId, studentId, assignment, total: row.total, status: row.status, revertedFromPublished },
        },
        tx,
      );
      return { result: this.toResultDto(grading, row, subject.name, student.name), revertedFromPublished };
    });
  }

  // ---------------------------------------------------------------------------
  // Publish — MAKER-CHECKER. The teacher's "publish" does NOT go live: it claims
  // the batch (DRAFT → PENDING_APPROVAL) and raises a GRADE_PUBLISH workflow
  // request through the head-teacher → principal chain. Only the final APPROVE
  // (via the finalized hook above) flips the batch to PUBLISHED.
  // ---------------------------------------------------------------------------
  async publishResults(
    p: Principal,
    args: { classId: string; subjectId: string; termId: string },
  ): Promise<{ pendingApproval: true; requestId: string; submitted: number }> {
    const { classId, subjectId, termId } = args;
    // Step 1 (tenant tx): validate scope + atomically CLAIM the draft batch.
    // The status filter doubles as the concurrency/idempotency guard — a second
    // concurrent publish finds no DRAFT rows and fails cleanly.
    const claimed = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!(await this.canGradeClassSubject(tx, p, classId, subjectId))) {
        throw new NotFoundException("Not found");
      }
      const [klass, subject, term] = await Promise.all([
        tx.class.findFirst({ where: { id: classId }, select: { name: true } }),
        tx.subject.findFirst({ where: { id: subjectId }, select: { name: true } }),
        tx.term.findFirst({ where: { id: termId }, select: { name: true } }),
      ]);
      if (!klass || !subject || !term) throw new NotFoundException("Not found");
      const res = await tx.subjectResult.updateMany({
        where: { classId, subjectId, termId, status: "DRAFT" },
        data: { status: "PENDING_APPROVAL" },
      });
      if (res.count === 0) {
        throw new BadRequestException(
          "No draft grades to submit — save scores first, or this batch is already awaiting approval or published.",
        );
      }
            // HOW MANY ARE PROVISIONAL. An approver publishing to families sees a
      // count of rows and nothing about whether the marks behind them are
      // finished — and a missing component counts as ZERO, so an unmarked exam
      // publishes as a fail. Counted here so the request can say it.
      const pending = await tx.subjectResult.findMany({
        where: { classId, subjectId, termId, status: "PENDING_APPROVAL" },
        select: { exam: true, midterm: true, assignment: true, classNote: true },
      });
      const incomplete = pending.filter(
        (r) => [r.exam, r.midterm, r.assignment, r.classNote].some((v) => v === null),
      ).length;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.publish.requested",
          entity: "subject_result",
          entityId: `${classId}:${subjectId}:${termId}`,
          schoolId: p.schoolId,
          metadata: { submitted: res.count, incomplete },
        },
        tx,
      );
      return { count: res.count, incomplete, title: `Publish grades: ${subject.name} — ${klass.name} (${term.name})` };
    });

    // Step 2: raise + submit the approval request. If this fails, RELEASE the
    // claim (rows back to DRAFT) so the batch can't strand without a reviewer.
    try {
      const req = (await this.workflow.createRequest(p, {
        type: "GRADE_PUBLISH",
        title: claimed.title,
        payload: {
          classId,
          subjectId,
          termId,
          count: claimed.count,
          incomplete: claimed.incomplete,
          // The approver's one-line summary — the same `payload.summary` the
          // inbox already surfaces. "12 grades" and "12 grades, 4 with a
          // component still unmarked" call for different decisions.
          summary:
            claimed.incomplete > 0
              ? `${claimed.count} grades — ${claimed.incomplete} with a component still unmarked, which publishes as if it scored zero`
              : `${claimed.count} grades, all components marked`,
        },
        stages: GRADE_PUBLISH_CHAIN,
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true, requestId: req.id, submitted: claimed.count };
    } catch (err) {
      await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.subjectResult.updateMany({
          where: { classId, subjectId, termId, status: "PENDING_APPROVAL" },
          data: { status: "DRAFT" },
        }),
      );
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Student session report (3 terms) — the report-card read
  // ---------------------------------------------------------------------------
  /** Whether the caller may view this student's full report (any status). */
  private async canReadReport(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (this.isReadWide(p)) return true;
    if (p.userId === studentId) return true;
    // The student's supervisor or any teacher of a class they're enrolled in.
    // SECURITY: ACTIVE only — see the note in documents.service. This is the
    // same check written backwards (collect the pupil's classes, then ask
    // whether the caller supervises or teaches one), so without the filter a
    // teacher kept access to the reports of a pupil who had left their class.
    // The pupil's OWN access returns above, so this narrows nobody's history.
    const enrollments = await tx.enrollment.findMany({
      where: { studentId, status: "ACTIVE" },
      select: { classId: true },
    });
    const classIds = enrollments.map((e) => e.classId);
    if (classIds.length) {
      const supervises = await tx.class.findFirst({
        where: { id: { in: classIds }, supervisorId: p.userId },
        select: { id: true },
      });
      if (supervises) return true;
      const teaches = await tx.classTeacher.findFirst({
        where: { classId: { in: classIds }, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return true;
      const teachesSubject = await tx.classSubjectTeacher.findFirst({
        where: { classId: { in: classIds }, teacherId: p.userId },
        select: { id: true },
      });
      if (teachesSubject) return true;
    }
    return false;
  }

  async getStudentSessionReport(
    p: Principal,
    args: { studentId: string; sessionId: string },
  ): Promise<StudentSessionReportDto> {
    const { studentId, sessionId } = args;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The SCHOOL's weighting and letter scale, resolved once for the whole
      // report. Every grade on it — each subject, and the term average beneath
      // them — now comes from this one policy; they used to come from two.
      const policy = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const session = await tx.academicSession.findFirst({
        where: { id: sessionId },
        select: { id: true, name: true },
      });
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { id: true, name: true } });
      if (!session || !student) throw new NotFoundException("Not found");

      const isStaffOrSelf = await this.canReadReport(tx, p, studentId);
      // Parents read their own children's PUBLISHED results.
      let allowed = isStaffOrSelf;
      if (!allowed) {
        const child = await tx.parentChild.findFirst({
          where: { parentId: p.userId, studentId },
          select: { id: true },
        });
        allowed = !!child;
      }
      if (!allowed) throw new NotFoundException("Not found");
      // Only staff-with-access see DRAFT rows; everyone else PUBLISHED only.
      const publishedOnly = !isStaffOrSelf || p.userId === studentId;

      const terms = await tx.term.findMany({
        where: { sessionId },
        orderBy: { sequence: "asc" },
        select: { id: true, name: true, sequence: true },
      });
      // Read EVERY row, then split. A family view still shows published marks
      // only — but a subject whose mark is not released yet used to vanish from
      // the report entirely, and a pupil looking at eight of their nine subjects
      // cannot tell whether the ninth is being marked, is held at review, or
      // whether they are simply not taking it. The subject is NAMED below
      // instead, with no figures attached.
      const allResults = await tx.subjectResult.findMany({ where: { studentId, sessionId } });
      const results = publishedOnly ? allResults.filter((r) => r.status === "PUBLISHED") : allResults;
      const awaiting = publishedOnly ? allResults.filter((r) => r.status !== "PUBLISHED") : [];
      const subjectIds = [...new Set([...results, ...awaiting].map((r) => r.subjectId))];
      const subjects = await tx.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      });
      const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

      // Current class (most recent enrollment) for the header.
      const enrollment = await tx.enrollment.findFirst({
        where: { studentId, status: "ACTIVE" },
        select: { classId: true },
        orderBy: { enrolledAt: "desc" },
      });
      let className: string | null = null;
      if (enrollment) {
        const klass = await tx.class.findFirst({ where: { id: enrollment.classId }, select: { name: true } });
        className = klass?.name ?? null;
      }

      // ---------------------------------------------------------------------
      // Per-subject class rank.
      //
      // Ranked over PUBLISHED results ONLY, whatever the viewer may see. A
      // position has to be the same number for the parent, the pupil and the
      // teacher — deriving it from the rows each of them is allowed to read
      // would make a teacher's copy disagree with the family's, and would move
      // a pupil's rank every time an unrelated mark was published.
      //
      // One extra query for classmates and one for their published totals. Both
      // are bounded by the class: 30 pupils x 10 subjects x 3 terms is ~900 rows,
      // and only the fields the total is computed from are selected.
      const rankOf = new Map<string, { position: number; ranked: number }>();
      if (enrollment) {
        const classmates = (await tx.enrollment.findMany({
          where: { classId: enrollment.classId, status: "ACTIVE" },
          select: { studentId: true },
        })) as Array<{ studentId: string }>;
        const ids = classmates.map((c) => c.studentId);
        if (ids.length > 0) {
          const peerRows = (await tx.subjectResult.findMany({
            where: { studentId: { in: ids }, sessionId, status: "PUBLISHED" },
          })) as typeof results;
          // Group by (term, subject), then rank each group.
          const groups = new Map<string, Array<{ studentId: string; total: number }>>();
          for (const r of peerRows) {
            const { total } = this.recomputeTotal(r, policy);
            if (total === null) continue; // ungraded is UNRANKED, never last
            const key = `${r.termId}:${r.subjectId}`;
            const arr = groups.get(key) ?? [];
            arr.push({ studentId: r.studentId, total });
            groups.set(key, arr);
          }
          for (const [key, arr] of groups) {
            arr.sort((a, b) => b.total - a.total);
            // Standard competition ranking: ties SHARE a position and the next
            // rank skips (68, 68, 65 -> 1st, 1st, 3rd). Telling two pupils on
            // the same mark they are 1st and 2nd is what makes a parent write in.
            let position = 0;
            let seen = 0;
            let prev: number | null = null;
            for (const row of arr) {
              seen += 1;
              if (prev === null || row.total < prev) position = seen;
              prev = row.total;
              if (row.studentId === studentId) {
                rankOf.set(key, { position, ranked: arr.length });
              }
            }
          }
        }
      }

      const termReports: StudentTermReportDto[] = terms.map((t) => {
        const rows: TermSubjectRowDto[] = results
          .filter((r) => r.termId === t.id)
          .map((r) => {
            const { total, grade, complete } = this.recomputeTotal(r, policy);
            return {
              subjectId: r.subjectId,
              subjectName: subjectName.get(r.subjectId) ?? "Unknown",
              subjectPosition: rankOf.get(`${r.termId}:${r.subjectId}`)?.position ?? null,
              subjectRanked: rankOf.get(`${r.termId}:${r.subjectId}`)?.ranked ?? null,
              exam: r.exam,
              midterm: r.midterm,
              assignment: r.assignment,
              classNote: r.classNote,
              total,
              grade,
              complete,
            };
          })
          .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
        const totals = rows.map((r) => r.total).filter((v): v is number => v !== null);
        const avg = averageOf(totals);
        return {
          termId: t.id,
          termName: t.name,
          sequence: t.sequence,
          subjects: rows,
          // Named, never scored: a subject the pupil takes whose mark is not
          // released yet. Empty for staff, who see every row anyway.
          awaitingRelease: awaiting
            .filter((r) => r.termId === t.id)
            .map((r) => subjectName.get(r.subjectId) ?? "Unknown")
            .sort((a, b) => a.localeCompare(b)),
          average: avg,
          // On the SCHOOL's scale, from the same policy the subject grades above
          // used. The report card derived this itself with no bands, so a school
          // with its own scale printed subject grades on one scale and the
          // overall grade beneath them on another.
          averageGrade: avg !== null ? gradeLetter(avg, resolveGradeBands(policy)) : null,
        };
      });
      const termAverages = termReports
        .map((t) => t.average)
        .filter((v): v is number => v !== null);

      // Per-subject cumulative summary across the session: each subject's total
      // in every term (in term order) + the average of the terms it was graded.
      // The last term's total is the "third-term-only" grade; `average` is the
      // three-term cumulative grade — the two final categories on the report.
      const summarySubjectIds = [...new Set(results.map((r) => r.subjectId))].sort(
        (a, b) => (subjectName.get(a) ?? "").localeCompare(subjectName.get(b) ?? ""),
      );
      const summary: SubjectSessionSummaryDto[] = summarySubjectIds.map((sid) => {
        const termTotals = termReports.map(
          (tr) => tr.subjects.find((s) => s.subjectId === sid)?.total ?? null,
        );
        const present = termTotals.filter((v): v is number => v !== null);
        return {
          subjectId: sid,
          subjectName: subjectName.get(sid) ?? "Unknown",
          termTotals,
          average: averageOf(present),
        };
      });

      return {
        sessionId,
        sessionName: session.name,
        studentId,
        studentName: student.name,
        className,
        terms: termReports,
        summary,
        sessionAverage: averageOf(termAverages),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Term scoresheet PDF — a student's/parent's downloadable result slip
  // ---------------------------------------------------------------------------
  /** Render ONE term of a student's report as a PDF. Reuses the fully-scoped
   *  session report (student→self / parent→children see PUBLISHED only; staff of
   *  the class see all), so the PDF can never leak a grade the caller couldn't
   *  already read on screen. Generating one is audit-logged. */
  async generateTermScoresheetPdf(
    p: Principal,
    args: { studentId: string; sessionId: string; termId: string },
  ): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.getStudentSessionReport(p, {
      studentId: args.studentId,
      sessionId: args.sessionId,
    });
    const term = report.terms.find((t) => t.termId === args.termId);
    if (!term) throw new NotFoundException("Term not found");

    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.scoresheet.download",
          entity: "user",
          entityId: args.studentId,
          schoolId: p.schoolId,
          metadata: { sessionId: args.sessionId, termId: args.termId },
        },
        tx,
      ),
    );

    const buffer = await this.renderTermScoresheetPdf(report, term);
    const slug = (s: string) => s.replace(/\s+/g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase();
    return { buffer, filename: `scoresheet-${slug(report.studentName)}-${slug(term.termName)}.pdf` };
  }

  private renderTermScoresheetPdf(
    report: StudentSessionReportDto,
    term: StudentTermReportDto,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text(report.sessionName || "Report", { align: "center" });
      doc.moveDown(0.2).fontSize(13).fillColor("#666").text(`${term.termName} — Score Sheet`, { align: "center" });
      doc.fillColor("#000").moveDown(1);
      doc.fontSize(11).text(`Student: ${report.studentName}`);
      if (report.className) doc.text(`Class: ${report.className}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown(0.8);

      // Column layout: subject + the four components + total + grade.
      const startX = 50;
      const colX = [startX, 210, 265, 330, 395, 450, 510];
      const headers = ["Subject", "Exam/60", "Mid/20", "Assn/10", "Note/10", "Total", "Grade"];
      const drawRow = (cells: string[], opts: { bold?: boolean } = {}) => {
        const y = doc.y;
        doc.fontSize(10).font(opts.bold ? "Helvetica-Bold" : "Helvetica");
        cells.forEach((c, i) => doc.text(c, colX[i], y, { width: (colX[i + 1] ?? 545) - colX[i] - 4, lineBreak: false }));
        doc.moveDown(0.6);
      };
      drawRow(headers, { bold: true });
      doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
      doc.moveDown(0.3);

      const fmt = (n: number | null): string => (n === null || n === undefined ? "—" : String(n));
      if (term.subjects.length === 0) {
        doc.fontSize(10).fillColor("#888").text("No published results for this term yet.", startX).fillColor("#000");
      } else {
        for (const s of term.subjects) {
          drawRow([s.subjectName, fmt(s.exam), fmt(s.midterm), fmt(s.assignment), fmt(s.classNote), fmt(s.total), s.grade ?? "—"]);
        }
      }
      doc.moveDown(0.5);
      doc.fontSize(11).font("Helvetica-Bold").text(`Term average: ${term.average ?? "—"}`, startX);
      // The cumulative session line for this subject set, if present.
      if (report.sessionAverage !== null) {
        doc.font("Helvetica").fillColor("#666").text(`Cumulative session average (all terms so far): ${report.sessionAverage}`, startX);
        doc.fillColor("#000");
      }
      doc.font("Helvetica").fontSize(8).fillColor("#999").moveDown(1)
        .text("Weighting: Exam 60 · Midterm 20 · Assignment 10 · Class note 10 = 100 per term.", startX);

      doc.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Session (CUMULATIVE) report PDF — every term + the per-subject session average
  // ---------------------------------------------------------------------------
  /** The whole session on one sheet: each term's subject grades, plus the
   *  cumulative summary (each subject's per-term totals and its session average,
   *  and the overall session average). Same scoping as the on-screen session
   *  report — a student/parent sees PUBLISHED only. Audited. */
  async generateSessionReportPdf(
    p: Principal,
    args: { studentId: string; sessionId: string },
  ): Promise<{ buffer: Buffer; filename: string }> {
    const report = await this.getStudentSessionReport(p, args);
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.session-report.download",
          entity: "user",
          entityId: args.studentId,
          schoolId: p.schoolId,
          metadata: { sessionId: args.sessionId },
        },
        tx,
      ),
    );
    const buffer = await this.renderSessionReportPdf(report);
    const slug = (x: string) => x.replace(/\s+/g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase();
    return { buffer, filename: `session-report-${slug(report.studentName)}-${slug(report.sessionName)}.pdf` };
  }

  private renderSessionReportPdf(report: StudentSessionReportDto): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      const startX = 50;
      const fmt = (n: number | null): string => (n === null || n === undefined ? "—" : String(n));

      doc.fontSize(20).text(report.sessionName || "Session report", { align: "center" });
      doc.moveDown(0.2).fontSize(13).fillColor("#666").text("Cumulative Session Report", { align: "center" });
      doc.fillColor("#000").moveDown(0.8);
      doc.fontSize(11).text(`Student: ${report.studentName}`);
      if (report.className) doc.text(`Class: ${report.className}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown(0.6);

      // Per-term blocks.
      const colX = [startX, 210, 265, 330, 395, 450, 510];
      const drawRow = (cells: string[], bold = false) => {
        const y = doc.y;
        doc.fontSize(9.5).font(bold ? "Helvetica-Bold" : "Helvetica");
        cells.forEach((c, i) => doc.text(c, colX[i], y, { width: (colX[i + 1] ?? 545) - colX[i] - 4, lineBreak: false }));
        doc.moveDown(0.55);
      };
      for (const term of report.terms) {
        doc.moveDown(0.3).fontSize(12).font("Helvetica-Bold").fillColor("#111")
          .text(`${term.termName}  (average ${fmt(term.average)})`, startX);
        doc.fillColor("#000").moveDown(0.2);
        drawRow(["Subject", "Exam/60", "Mid/20", "Assn/10", "Note/10", "Total", "Grade"], true);
        doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
        doc.moveDown(0.2);
        if (term.subjects.length === 0) {
          doc.fontSize(9).fillColor("#888").text("No published results for this term.", startX).fillColor("#000");
        } else {
          for (const sub of term.subjects) {
            drawRow([sub.subjectName, fmt(sub.exam), fmt(sub.midterm), fmt(sub.assignment), fmt(sub.classNote), fmt(sub.total), sub.grade ?? "—"]);
          }
        }
      }

      // Cumulative summary: each subject across the session's terms + its average.
      doc.moveDown(0.6).fontSize(13).font("Helvetica-Bold").fillColor("#111").text("Cumulative summary", startX);
      doc.fillColor("#000").moveDown(0.2);
      const termCols = report.terms.map((_, i) => 210 + i * 70);
      const sumColX = [startX, ...termCols, 210 + report.terms.length * 70];
      const sumHeader = ["Subject", ...report.terms.map((t) => t.termName.replace(/term/i, "T").slice(0, 8)), "Session avg"];
      const drawSum = (cells: string[], bold = false) => {
        const y = doc.y;
        doc.fontSize(9.5).font(bold ? "Helvetica-Bold" : "Helvetica");
        cells.forEach((c, i) => doc.text(c, sumColX[i] ?? startX, y, { width: (sumColX[i + 1] ?? 545) - (sumColX[i] ?? startX) - 4, lineBreak: false }));
        doc.moveDown(0.55);
      };
      drawSum(sumHeader, true);
      doc.moveTo(startX, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
      doc.moveDown(0.2);
      for (const row of report.summary) {
        drawSum([row.subjectName, ...row.termTotals.map(fmt), fmt(row.average)]);
      }
      doc.moveDown(0.5).fontSize(12).font("Helvetica-Bold")
        .text(`Overall session average: ${fmt(report.sessionAverage)}`, startX);
      doc.font("Helvetica").fontSize(8).fillColor("#999").moveDown(0.8)
        .text("Term weighting: Exam 60 · Midterm 20 · Assignment 10 · Class note 10 = 100. Session average = mean of the term averages.", startX);
      doc.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Class broadsheet — the supervisor's whole-class score sheet for one term
  // ---------------------------------------------------------------------------
  /** Whether the caller may view a whole class's broadsheet: the class's named
   *  supervisor, any teacher of the class (form teacher or a subject teacher),
   *  or a school-wide role. Anyone else gets 404 (never reveal existence). */
  private async canViewClass(tx: TenantTx, p: Principal, classId: string): Promise<boolean> {
    if (this.isReadWide(p)) return true;
    const klass = await tx.class.findFirst({ where: { id: classId }, select: { supervisorId: true } });
    if (klass?.supervisorId === p.userId) return true;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    if (teaches) return true;
    const teachesSubject = await tx.classSubjectTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    return !!teachesSubject;
  }

  /** Every student in `classId` down the side, every subject offered on the class
   *  across the top, each cell the recomputed subject total + grade for `termId`,
   *  plus each student's average across subjects and their class position. This
   *  is the working sheet for staff-of-class, so it shows ALL statuses (DRAFT
   *  included) — it is NOT the family view. Caller must supervise/teach the class
   *  (else 404). */
  /**
   * How each class-subject performed this term.
   *
   * TWO AUDIENCES, ONE QUERY. A subject teacher gets the class-subjects THEY
   * teach; leadership gets the school's. The split reuses what already exists
   * rather than introducing a parallel idea of who-may-see-what:
   *
   *   * `classSubjectTeacher` is the definition of "the subjects I teach" — it
   *     already decides who may GRADE a class-subject, so what a teacher can
   *     analyse can never drift from what they can mark;
   *   * `READ_WIDE_ROLES` is already this service's answer to "who may read any
   *     class's marks" (principal, head_teacher, school_admin, board,
   *     junior_admin), so leadership needs no new permission and no seed change.
   *
   * Anyone else — a parent or pupil, who both hold `grade.read` — resolves to an
   * empty offering set and therefore an empty result. That falls out of the
   * scoping rather than needing a special case, and discloses nothing.
   *
   * ONE aggregate, computed in Postgres. The alternative is reading every mark
   * in the term into Node to average them, which grows with the school and with
   * every year it stays on the platform; `subject_result` is already indexed on
   * (schoolId, classId, subjectId, termId), which is exactly this GROUP BY.
   */
  async subjectAnalytics(
    p: Principal,
    args: { termId: string; classId?: string; subjectId?: string },
  ): Promise<SubjectAnalyticsDto> {
    const { termId } = args;
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const schoolWide = this.isReadWide(p);
      const bands = resolveGradeBands((await this.region.academicInTx(tx, p.schoolId)).grading);

      // The class-subjects this caller may look at.
      let pairs: Array<{ classId: string; subjectId: string }> | null = null; // null = everything
      if (!schoolWide) {
        const mine = await tx.classSubjectTeacher.findMany({
          where: { teacherId: p.userId },
          select: { classId: true, subjectId: true },
        });
        pairs = mine.map((o) => ({ classId: o.classId, subjectId: o.subjectId }));
        if (pairs.length === 0) return { termId, scope: "teaching", rows: [] };
      }

      const filters = [Prisma.sql`sr."termId" = ${termId}::uuid`];
      if (args.classId) filters.push(Prisma.sql`sr."classId" = ${args.classId}::uuid`);
      if (args.subjectId) filters.push(Prisma.sql`sr."subjectId" = ${args.subjectId}::uuid`);
      if (pairs) {
        // The caller's own offerings, as pairs — never "any of my classes" x "any
        // of my subjects", which would show a teacher a colleague's subject in a
        // class they happen to share.
        const tuples = pairs.map((o) => Prisma.sql`(${o.classId}::uuid, ${o.subjectId}::uuid)`);
        filters.push(Prisma.sql`(sr."classId", sr."subjectId") IN (${Prisma.join(tuples, ", ")})`);
      }

      // Band counts over the school's own scale, in its own order — the same
      // resolveGradeBands the report card grades on, so a WAEC school sees its
      // nine bands here too.
      const bandCols = bands.map((b, i) => {
        const upper = i === 0 ? null : bands[i - 1].min;
        const cond =
          upper === null
            ? Prisma.sql`sr.total >= ${b.min}`
            : Prisma.sql`sr.total >= ${b.min} AND sr.total < ${upper}`;
        return Prisma.sql`count(*) FILTER (WHERE sr.total IS NOT NULL AND ${cond})::int AS ${Prisma.raw(
          `"band_${b.grade.replace(/[^\w]/g, "")}"`,
        )}`;
      });

      const rows = await tx.$queryRaw<
        Array<Record<string, string | number | null>>
      >(Prisma.sql`
        SELECT sr."classId"::text          AS "classId",
               sr."subjectId"::text        AS "subjectId",
               c.name                      AS "className",
               s.name                      AS "subjectName",
               count(*)::int               AS entered,
               count(*) FILTER (WHERE sr.status = 'PUBLISHED')::int AS published,
               ROUND(AVG(sr.total)::numeric, 1)::float8      AS "averageTotal",
               MAX(sr.total)::float8       AS highest,
               MIN(sr.total)::float8       AS lowest,
               ROUND(AVG(sr.exam)::numeric, 1)::float8       AS "avgExam",
               ROUND(AVG(sr.midterm)::numeric, 1)::float8    AS "avgMidterm",
               ROUND(AVG(sr.assignment)::numeric, 1)::float8 AS "avgAssignment",
               ROUND(AVG(sr."classNote")::numeric, 1)::float8 AS "avgClassNote"
               ${bandCols.length ? Prisma.sql`, ${Prisma.join(bandCols, ", ")}` : Prisma.empty}
        FROM subject_result sr
        JOIN class c   ON c.id = sr."classId"
        JOIN subject s ON s.id = sr."subjectId"
        WHERE ${Prisma.join(filters, " AND ")}
        GROUP BY sr."classId", sr."subjectId", c.name, s.name
        ORDER BY c.name, s.name`);

      const num = (v: string | number | null | undefined): number | null =>
        v === null || v === undefined ? null : Number(v);

      return {
        termId,
        scope: schoolWide ? "school" : "teaching",
        rows: rows.map((r) => ({
          classId: String(r.classId),
          className: String(r.className ?? ""),
          subjectId: String(r.subjectId),
          subjectName: String(r.subjectName ?? ""),
          entered: Number(r.entered ?? 0),
          published: Number(r.published ?? 0),
          averageTotal: num(r.averageTotal),
          highest: num(r.highest),
          lowest: num(r.lowest),
          components: {
            exam: num(r.avgExam),
            midterm: num(r.avgMidterm),
            assignment: num(r.avgAssignment),
            classNote: num(r.avgClassNote),
          },
          bands: bands.map((b) => ({
            grade: b.grade,
            count: Number(r[`band_${b.grade.replace(/[^\w]/g, "")}`] ?? 0),
          })),
        })),
      };
    });
  }

  async getClassBroadsheet(
    p: Principal,
    args: { classId: string; termId: string },
  ): Promise<ClassBroadsheetDto> {
    const { classId, termId } = args;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The broadsheet is what a head teacher reads a whole class off. It must
      // be the school's own weighting — the same numbers the report cards carry.
      const policy = (await this.region.academicInTx(tx, p.schoolId)).grading;
      const [klass, term] = await Promise.all([
        tx.class.findFirst({ where: { id: classId }, select: { id: true, name: true } }),
        tx.term.findFirst({ where: { id: termId }, select: { id: true, name: true, sessionId: true } }),
      ]);
      if (!klass || !term) throw new NotFoundException("Not found");
      if (!(await this.canViewClass(tx, p, classId))) throw new NotFoundException("Not found");

      // Columns: the subjects offered on this class. Rows: its ACTIVE students.
      const offerings = await tx.classSubjectTeacher.findMany({
        where: { classId },
        select: { subjectId: true },
      });
      const subjectIds = [...new Set(offerings.map((o) => o.subjectId))];
      const [subjectRows, enrollments, results] = await Promise.all([
        tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
        tx.enrollment.findMany({ where: { classId, status: "ACTIVE" }, select: { studentId: true } }),
        tx.subjectResult.findMany({ where: { classId, termId } }),
      ]);
      const subjects = subjectRows.sort((a, b) => a.name.localeCompare(b.name));
      const orderedSubjectIds = subjects.map((s) => s.id);
      const studentIds = [...new Set(enrollments.map((e) => e.studentId))];
      const [students, profiles] = await Promise.all([
        tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } }),
        tx.studentProfile.findMany({
          where: { studentId: { in: studentIds } },
          select: { studentId: true, admissionNumber: true },
        }),
      ]);
      const nameById = new Map(students.map((s) => [s.id, s.name]));
      const admById = new Map(profiles.map((pr) => [pr.studentId, pr.admissionNumber]));
      const cellByKey = new Map(results.map((r) => [`${r.studentId}:${r.subjectId}`, r]));

      const rows = studentIds
        .map((sid) => {
          const cells = orderedSubjectIds.map((subId) => {
            const r = cellByKey.get(`${sid}:${subId}`);
            const { total, grade, complete } = r
              ? this.recomputeTotal(r, policy)
              : { total: null, grade: null, complete: false };
            return { subjectId: subId, total, grade, complete, status: r?.status ?? "" };
          });
          const totals = cells.map((c) => c.total).filter((v): v is number => v !== null);
          return {
            studentId: sid,
            studentName: nameById.get(sid) ?? "Unknown",
            admissionNumber: admById.get(sid) ?? null,
            cells,
            average: averageOf(totals),
            position: null as number | null,
          };
        })
        .sort((a, b) => a.studentName.localeCompare(b.studentName));

      // Rank by average (highest first); ties share a position (competition rank).
      const ranked = [...rows]
        .filter((r) => r.average !== null)
        .sort((a, b) => (b.average as number) - (a.average as number));
      let position = 0;
      let seen = 0;
      let prev: number | null = null;
      for (const r of ranked) {
        seen += 1;
        if (prev === null || r.average !== prev) {
          position = seen;
          prev = r.average;
        }
        r.position = position;
      }

      return {
        classId,
        className: klass.name,
        sessionId: term.sessionId,
        termId,
        termName: term.name,
        subjects: subjects.map((s) => ({ id: s.id, name: s.name })),
        rows,
      };
    });
  }
}
