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
import {
  computeTermSubjectGrade,
  averageOf,
  GRADE_PUBLISH_CHAIN,
  type GradingRosterDto,
  type SubjectResultDto,
  type StudentSessionReportDto,
  type StudentTermReportDto,
  type TermSubjectRowDto,
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

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);

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

  /** Recompute total/grade from components and validate ranges (0..100). */
  private applyComponents(c: ComponentInput) {
    for (const [k, v] of Object.entries(c)) {
      if (v !== null && v !== undefined && (v < 0 || v > 100)) {
        throw new BadRequestException(`${k} must be between 0 and 100`);
      }
    }
    const components = {
      exam: c.exam ?? null,
      midterm: c.midterm ?? null,
      assignment: c.assignment ?? null,
      classNote: c.classNote ?? null,
    };
    const anyEntered = Object.values(components).some((v) => v !== null);
    const { total, grade } = computeTermSubjectGrade(components);
    return {
      ...components,
      // total/grade only meaningful once at least one component is entered.
      total: anyEntered ? total : null,
      grade: anyEntered ? grade : null,
    };
  }

  private toResultDto(
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
      total: row.total,
      grade: row.grade,
      status: row.status,
      gradedById: row.gradedById,
      gradedAt: row.gradedAt,
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
            ? this.toResultDto(resultByStudent.get(sid)!, subject.name, nameById.get(sid) ?? "Unknown")
            : null,
        }))
        .sort((a, b) => a.studentName.localeCompare(b.studentName));

      return {
        classId,
        className: klass.name,
        subjectId,
        subjectName: subject.name,
        sessionId: term.sessionId,
        termId,
        termName: term.name,
        students: roster,
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
      const unpublished = existing?.status === "PUBLISHED";

      const scored = this.applyComponents(input);
      const data = { ...scored, gradedById: p.userId, gradedAt: new Date() };
      const row = await tx.subjectResult.upsert({
        where: { sessionId_termId_subjectId_studentId: { sessionId: term.sessionId, termId, subjectId, studentId } },
        create: { schoolId: p.schoolId, sessionId: term.sessionId, termId, classId, subjectId, studentId, ...data },
        // classId can change if the student moved classes mid-term — keep it current.
        update: { classId, ...data, ...(unpublished ? { status: "DRAFT" } : {}) },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.grade.set",
          entity: "subject_result",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { termId, subjectId, studentId, total: row.total, status: row.status, unpublished },
        },
        tx,
      );
      return this.toResultDto(row, subject.name, student.name);
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
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.term.publish.requested",
          entity: "subject_result",
          entityId: `${classId}:${subjectId}:${termId}`,
          schoolId: p.schoolId,
          metadata: { submitted: res.count },
        },
        tx,
      );
      return { count: res.count, title: `Publish grades: ${subject.name} — ${klass.name} (${term.name})` };
    });

    // Step 2: raise + submit the approval request. If this fails, RELEASE the
    // claim (rows back to DRAFT) so the batch can't strand without a reviewer.
    try {
      const req = (await this.workflow.createRequest(p, {
        type: "GRADE_PUBLISH",
        title: claimed.title,
        payload: { classId, subjectId, termId, count: claimed.count },
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
    if (this.isSchoolWide(p)) return true;
    if (p.userId === studentId) return true;
    // The student's supervisor or any teacher of a class they're enrolled in.
    const enrollments = await tx.enrollment.findMany({
      where: { studentId },
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
      const results = await tx.subjectResult.findMany({
        where: {
          studentId,
          sessionId,
          ...(publishedOnly ? { status: "PUBLISHED" } : {}),
        },
      });
      const subjectIds = [...new Set(results.map((r) => r.subjectId))];
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

      const termReports: StudentTermReportDto[] = terms.map((t) => {
        const rows: TermSubjectRowDto[] = results
          .filter((r) => r.termId === t.id)
          .map((r) => ({
            subjectId: r.subjectId,
            subjectName: subjectName.get(r.subjectId) ?? "Unknown",
            exam: r.exam,
            midterm: r.midterm,
            assignment: r.assignment,
            classNote: r.classNote,
            total: r.total,
            grade: r.grade,
          }))
          .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
        const totals = rows.map((r) => r.total).filter((v): v is number => v !== null);
        return {
          termId: t.id,
          termName: t.name,
          sequence: t.sequence,
          subjects: rows,
          average: averageOf(totals),
        };
      });
      const termAverages = termReports
        .map((t) => t.average)
        .filter((v): v is number => v !== null);

      return {
        sessionId,
        sessionName: session.name,
        studentId,
        studentName: student.name,
        className,
        terms: termReports,
        sessionAverage: averageOf(termAverages),
      };
    });
  }
}
