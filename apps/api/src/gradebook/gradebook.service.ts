// =============================================================================
// GradebookService — manual grading + read scoping
// =============================================================================
//  - grade.write: a teacher may grade a submission only if they teach the
//    assessment's class (or created the assessment), or are school_admin.
//  - grade.read: teachers-of-class/admin see any grade (incl. DRAFT); a student
//    sees only their OWN, PUBLISHED grade; a parent only their CHILD'S PUBLISHED.
// All inside a tenant transaction (RLS), writes audit-logged, not-visible -> 404.
// A grade is ALWAYS a human decision — never derived from integrity (GR#8).
// =============================================================================

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);

interface GradeInput {
  score: number;
  maxScore: number;
  feedback?: string;
  status?: "DRAFT" | "PUBLISHED";
}

@Injectable()
export class GradebookService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /** Can this caller grade this submission? Teacher-of-class, assessment author,
   *  or school_admin. */
  private async canGrade(
    tx: TenantTx,
    p: Principal,
    submission: { assessmentId: string },
  ): Promise<boolean> {
    if (this.isSchoolWide(p)) return true;
    const assessment = await tx.assessment.findFirst({
      where: { id: submission.assessmentId },
      select: { createdById: true, classId: true },
    });
    if (!assessment) return false;
    if (assessment.createdById === p.userId) return true;
    if (assessment.classId) {
      const teaches = await tx.classTeacher.findFirst({
        where: { classId: assessment.classId, teacherId: p.userId },
        select: { id: true },
      });
      if (teaches) return true;
    }
    return false;
  }

  async gradeSubmission(p: Principal, submissionId: string, input: GradeInput) {
    if (input.maxScore <= 0) throw new BadRequestException("maxScore must be > 0");
    if (input.score < 0 || input.score > input.maxScore) {
      throw new BadRequestException("score must be between 0 and maxScore");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const submission = await tx.submission.findFirst({
        where: { id: submissionId },
        select: { id: true, assessmentId: true },
      });
      if (!submission) throw new NotFoundException("Submission not found");
      // SECURITY: 404 (not 403) if the caller may not grade it.
      if (!(await this.canGrade(tx, p, submission))) {
        throw new NotFoundException("Submission not found");
      }
      const data = {
        score: input.score,
        maxScore: input.maxScore,
        feedback: input.feedback ?? null,
        status: input.status ?? "DRAFT",
        gradedById: p.userId,
      };
      const grade = await tx.grade.upsert({
        where: { submissionId },
        create: { schoolId: p.schoolId, submissionId, ...data },
        update: data,
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "gradebook.grade.set",
          entity: "submission",
          entityId: submissionId,
          schoolId: p.schoolId,
          metadata: { status: data.status },
        },
        tx,
      );
      return grade;
    });
  }

  async getSubmissionGrade(p: Principal, submissionId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const submission = await tx.submission.findFirst({
        where: { id: submissionId },
        select: { id: true, assessmentId: true, studentId: true },
      });
      if (!submission) throw new NotFoundException("Grade not found");
      const grade = await tx.grade.findUnique({ where: { submissionId } });
      if (!grade) throw new NotFoundException("Grade not found");

      // Teachers-of-class / admin / author see any status.
      if (await this.canGrade(tx, p, submission)) return grade;
      // Student: only their own, published.
      if (submission.studentId === p.userId && grade.status === "PUBLISHED") return grade;
      // Parent: only their child's, published.
      const isChild = await tx.parentChild.findFirst({
        where: { parentId: p.userId, studentId: submission.studentId },
        select: { id: true },
      });
      if (isChild && grade.status === "PUBLISHED") return grade;
      // SECURITY: hide existence otherwise.
      throw new NotFoundException("Grade not found");
    });
  }

  /** Published grades for the caller's own submissions and their children's. */
  async listMyGrades(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const studentIds = new Set<string>([p.userId]);
      const children = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      children.forEach((c: { studentId: string }) => studentIds.add(c.studentId));

      const submissions = await tx.submission.findMany({
        where: { studentId: { in: [...studentIds] } },
        select: { id: true },
      });
      if (submissions.length === 0) return [];
      return tx.grade.findMany({
        where: {
          submissionId: { in: submissions.map((s: { id: string }) => s.id) },
          status: "PUBLISHED",
        },
        orderBy: { gradedAt: "desc" },
      });
    });
  }
}
