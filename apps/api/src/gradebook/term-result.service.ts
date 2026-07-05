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
import PDFDocument from "pdfkit";
import {
  computeTermSubjectGrade,
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

  /** Recompute total/grade from components; validate each mark against ITS OWN
   *  maximum (exam ≤ 60, midterm ≤ 20, assignment ≤ 10, class note ≤ 10) so a
   *  teacher can't award more than a component is worth. */
  private applyComponents(c: ComponentInput) {
    const label: Record<GradeComponentKey, string> =
      Object.fromEntries(GRADE_COMPONENTS.map((g) => [g.key, g.label])) as Record<GradeComponentKey, string>;
    for (const key of GRADE_COMPONENTS.map((g) => g.key)) {
      const v = c[key];
      if (v === null || v === undefined) continue;
      const max = gradeComponentMax(key);
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
    const { total, grade } = computeTermSubjectGrade(components);
    return {
      ...components,
      // total/grade only meaningful once at least one component is entered.
      total: anyEntered ? total : null,
      grade: anyEntered ? grade : null,
    };
  }

  /** Recompute the total/grade from a row's four components at READ time, so a
   *  report is correct even if the denormalised `total` column was written under
   *  an older scoring rule (or left stale). Returns null total when nothing is
   *  entered yet. */
  private recomputeTotal(row: {
    exam: number | null;
    midterm: number | null;
    assignment: number | null;
    classNote: number | null;
  }): { total: number | null; grade: string | null } {
    const anyEntered = [row.exam, row.midterm, row.assignment, row.classNote].some((v) => v !== null);
    if (!anyEntered) return { total: null, grade: null };
    const { total, grade } = computeTermSubjectGrade({
      exam: row.exam,
      midterm: row.midterm,
      assignment: row.assignment,
      classNote: row.classNote,
    });
    return { total, grade };
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
    const { total, grade } = this.recomputeTotal(row);
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
          .map((r) => {
            const { total, grade } = this.recomputeTotal(r);
            return {
              subjectId: r.subjectId,
              subjectName: subjectName.get(r.subjectId) ?? "Unknown",
              exam: r.exam,
              midterm: r.midterm,
              assignment: r.assignment,
              classNote: r.classNote,
              total,
              grade,
            };
          })
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
  // Class broadsheet — the supervisor's whole-class score sheet for one term
  // ---------------------------------------------------------------------------
  /** Whether the caller may view a whole class's broadsheet: the class's named
   *  supervisor, any teacher of the class (form teacher or a subject teacher),
   *  or a school-wide role. Anyone else gets 404 (never reveal existence). */
  private async canViewClass(tx: TenantTx, p: Principal, classId: string): Promise<boolean> {
    if (this.isSchoolWide(p)) return true;
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
  async getClassBroadsheet(
    p: Principal,
    args: { classId: string; termId: string },
  ): Promise<ClassBroadsheetDto> {
    const { classId, termId } = args;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
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
            const { total, grade } = r ? this.recomputeTotal(r) : { total: null, grade: null };
            return { subjectId: subId, total, grade, status: r?.status ?? "" };
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
