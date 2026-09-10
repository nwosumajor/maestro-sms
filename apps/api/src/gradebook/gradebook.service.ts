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
import { MY_MARKS_PAGE_SIZE, type MyMarksPageDto } from "@sms/types";
import { teachesClass } from "../common/teaches";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

// `principal` holds grade.write; leaving them out of this set made every row of
// that permission a 404.
const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal"]);

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
      const teaches = (await teachesClass(tx, p.userId, assessment.classId) ? { id: "" } : null);
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

  /**
   * Published marks for the caller's own work and their children's — FOR ONE
   * TERM, and paged.
   *
   * It used to be every mark, ever. It read EVERY submission the pupil had ever
   * made, fed those ids back as an `IN` list, and returned every published grade
   * against them with no page, no cap and no period. That is bounded by how long
   * the pupil has been at the school, not by anything on the screen, and a
   * parent's view unions their children so a family multiplies it.
   *
   * Measured on a fleet aged three years, one pupil with a realistic record:
   *
   *     a pupil, 3 years in           810 marks   277 KB   59 ms
   *     a parent of three, 3 years in 2,430 marks 831 KB  116 ms
   *
   * Nothing was lost — there is no cap to drop rows — so it degrades invisibly,
   * which is what makes an O(lifetime) read the shape it is: at six years that
   * parent is fetching 1.7 MB to look at this week's marks.
   *
   * AND THE SCREEN ALREADY SAID IT WAS ONE TERM. `MyMarks` renders "Nothing has
   * been marked yet this term" over a list that was all-time, so a pupil three
   * years in was shown three years of work under a heading about this term and
   * could not tell which was which.
   *
   * So the period is now real: the school's CURRENT term by default, any term on
   * request, and paged within it. Nothing becomes unreachable — the screen
   * offers the other terms — which is what separates bounding a read from
   * truncating a record.
   */
  async listMyGrades(
    p: Principal,
    opts: { termId?: string; page?: number } = {},
  ): Promise<MyMarksPageDto> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = MY_MARKS_PAGE_SIZE;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const studentIds = new Set<string>([p.userId]);
      const children = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      children.forEach((c: { studentId: string }) => studentIds.add(c.studentId));

      // The term being shown, and the ones that can be asked for. A pupil's own
      // terms, newest first — so the picker cannot offer a term this school
      // does not have.
      const terms = (await tx.term.findMany({
        orderBy: [{ startDate: "desc" }],
        select: { id: true, name: true, isCurrent: true, startDate: true },
      })) as Array<{ id: string; name: string; isCurrent: boolean; startDate: Date | null }>;
      const asked = opts.termId ? terms.find((t) => t.id === opts.termId) : undefined;
      // An unknown termId is refused rather than quietly widened to everything —
      // a filter this caller cannot satisfy is not answered with more data.
      if (opts.termId && !asked) throw new NotFoundException("Term not found");
      const term = asked ?? terms.find((t) => t.isCurrent) ?? terms[0] ?? null;

      const where = {
        status: "PUBLISHED" as const,
        // THROUGH THE RELATION, not an `IN` list of every submission id the
        // pupil has ever produced — that list was the thing that grew.
        submission: {
          studentId: { in: [...studentIds] },
          // An assessment with no term is included in EVERY term, which is the
          // same fail-open the report card takes for untagged work: a school
          // part-way through tagging must not have its history vanish. Each row
          // carries its own date, so the reader can still place it.
          ...(term ? { assessment: { OR: [{ termId: term.id }, { termId: null }] } } : {}),
        },
      };
      const [rows, total] = await Promise.all([
        tx.grade.findMany({
          where,
          // `id` IS THE TIEBREAKER, and without it this pages wrongly.
          //
          // `gradedAt` alone is not a total order — a teacher marking a set of
          // work stamps the whole batch within the same second — and offset
          // paging over a non-total order lets Postgres return tied rows in a
          // different order per page, which silently SKIPS some and repeats
          // others. Caught by driving it: a parent of three with 270 marks in
          // the term paged six pages and saw 239 distinct rows. Nothing in the
          // response said 31 were missing.
          orderBy: [{ gradedAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.grade.count({ where }),
      ]);
      return {
        items: rows as unknown as MyMarksPageDto["items"],
        total,
        page,
        pageSize,
        termId: term?.id ?? null,
        termName: term?.name ?? null,
        terms: terms.map((t) => ({ id: t.id, name: t.name })),
      };
    });
  }
}
