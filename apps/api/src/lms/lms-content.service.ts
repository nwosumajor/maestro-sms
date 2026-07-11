// =============================================================================
// LmsContentService — learning content (materials/lessons/quizzes/forum)
// =============================================================================
// Authoring is relationship-scoped (teacher OF the class, or school_admin);
// publication is APPROVAL-GATED through the workflow engine, with the PRINCIPAL
// as approver (separation of duties: the approver is never the author). Enrolled
// students see only PUBLISHED content (quiz answer keys stripped), may take a
// quiz once (auto-graded server-side), and may reply in a published forum thread.
// PDFs use the same pluggable StorageProvider as the Document Vault (presigned
// upload/download; bytes never touch the API). 404-not-403; every mutation audited.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import type {
  ClassProgressDto,
  LiveProvider,
  LiveStatus,
  LmsAnalyticsDto,
  LmsAwardDto,
  LmsGradebookDto,
  LmsGradeRowDto,
  LmsLiveAttendanceDto,
  LmsLiveSessionDto,
  LmsModuleDto,
  LmsRevisionDto,
  LmsSubmissionDto,
  QuizAttemptGradeDto,
  ForumPostDto,
  LmsContentBody,
  LmsContentDto,
  LmsContentStatus,
  LmsContentType,
  LmsPresignDto,
  QuizAttemptResultDto,
  QuizDefDto,
  WorkflowAction,
  XapiResult,
  XapiStatementDto,
  XapiVerb,
} from "@sms/types";
import { badgeMeta, gradeComponentMax, isBadgeKey } from "@sms/types";
import { isXapiVerb, normalizeXapiResult } from "./xapi.util";
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
import { NotificationService } from "../notifications/notification.service";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import {
  canonicalEmbedUrl,
  computeEngagementPercent,
  gradeQuiz,
  htmlToBlocks,
  isValidQuiz,
  normalizeBlocks,
  pickQuestions,
  redactQuiz,
  scaleToComponent,
} from "./lms-content.util";
import { isJoinable, normalizeJoinUrl } from "./lms-live.util";
import { TermResultService } from "../gradebook/term-result.service";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);
const CONTENT_TYPES = new Set<LmsContentType>(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD", "VIDEO", "ASSIGNMENT"]);
// Only these two content types can be tagged with a (subject, term) and pulled
// into the report card — the rest aren't numerically graded.
const GRADABLE_TYPES = new Set<LmsContentType>(["QUIZ", "ASSIGNMENT"]);

type ContentRow = {
  id: string;
  schoolId: string;
  classId: string;
  type: string;
  title: string;
  body: Prisma.JsonValue;
  status: string;
  authorId: string;
  approvalRequestId: string | null;
  moduleId: string | null;
  subjectId: string | null;
  termId: string | null;
  fileKey: string | null;
  fileName: string | null;
  fileUploaded: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type SubmissionRow = {
  id: string;
  schoolId: string;
  contentId: string;
  studentId: string;
  text: string;
  status: string;
  late: boolean;
  grade: number | null;
  feedback: string | null;
  gradedById: string | null;
  gradedAt: Date | null;
  submittedAt: Date;
  updatedAt: Date;
};

@Injectable()
export class LmsContentService {
  private readonly logger = new Logger(LmsContentService.name);

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    private readonly notifications: NotificationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly termResults: TermResultService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  // --- authoring (teacher of class / school_admin) --------------------------
  async createContent(
    p: Principal,
    input: {
      classId: string;
      type: LmsContentType;
      title: string;
      body: LmsContentBody;
      subjectId?: string | null;
      termId?: string | null;
    },
  ): Promise<LmsContentDto> {
    if (!CONTENT_TYPES.has(input.type)) throw new BadRequestException("invalid content type");
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");
    const body = this.validateBody(input.type, input.body);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, input.classId);
      const tag = await this.validateGradeTag(tx, input.type, input.classId, input.subjectId, input.termId);
      const row = (await tx.lmsContent.create({
        data: {
          schoolId: p.schoolId,
          classId: input.classId,
          type: input.type,
          title,
          body: body as unknown as Prisma.InputJsonValue,
          status: "DRAFT",
          authorId: p.userId,
          subjectId: tag.subjectId,
          termId: tag.termId,
        },
      })) as ContentRow;
      await this.snapshot(tx, p, row, "Created");
      await this.log(tx, p, "lms.content.create", row.id, { classId: input.classId, type: input.type });
      return this.toDto(row, true, await this.nameOf(tx, row.authorId));
    });
  }

  async updateContent(
    p: Principal,
    contentId: string,
    input: { title?: string; body?: LmsContentBody; subjectId?: string | null; termId?: string | null },
  ): Promise<LmsContentDto> {
    const tagProvided = input.subjectId !== undefined || input.termId !== undefined;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (row.status !== "DRAFT" && row.status !== "REVISION_REQUESTED") {
        throw new ConflictException("Only draft / revision-requested content can be edited");
      }
      const normalized = input.body ? this.validateBody(row.type as LmsContentType, input.body) : undefined;
      const tag = tagProvided
        ? await this.validateGradeTag(tx, row.type as LmsContentType, row.classId, input.subjectId, input.termId)
        : undefined;
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: {
          ...(input.title ? { title: input.title.trim() } : {}),
          ...(normalized ? { body: normalized as unknown as Prisma.InputJsonValue } : {}),
          ...(tag ? { subjectId: tag.subjectId, termId: tag.termId } : {}),
        },
      })) as ContentRow;
      await this.snapshot(tx, p, updated, "Edited");
      await this.log(tx, p, "lms.content.update", contentId);
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
    });
  }

  // --- PDF material upload (presigned, like the Document Vault) --------------
  async presignUpload(
    p: Principal,
    contentId: string,
    input: { fileName: string; contentType: string },
  ): Promise<LmsPresignDto> {
    const presign = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (row.type !== "MATERIAL") throw new BadRequestException("Only MATERIAL content takes a file");
      if (row.status !== "DRAFT" && row.status !== "REVISION_REQUESTED") {
        throw new ConflictException("Content is locked for upload");
      }
      const safe = (input.fileName ?? "file.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `lms/${p.schoolId}/${contentId}/${Date.now()}_${safe}`;
      await tx.lmsContent.update({
        where: { id: contentId },
        data: { fileKey: key, fileName: input.fileName, fileUploaded: false },
      });
      await this.log(tx, p, "lms.content.upload.presign", contentId, { fileName: input.fileName });
      return { key, contentType: input.contentType };
    });
    return this.storage.presignUpload({ key: presign.key, contentType: presign.contentType });
  }

  async confirmUpload(p: Principal, contentId: string): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (!row.fileKey) throw new BadRequestException("No upload was started");
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: { fileUploaded: true },
      })) as ContentRow;
      await this.log(tx, p, "lms.content.upload.confirm", contentId);
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
    });
  }

  async downloadUrl(p: Principal, contentId: string): Promise<LmsPresignDto> {
    const file = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertCanRead(tx, p, row);
      if (row.type !== "MATERIAL" || !row.fileKey || !row.fileUploaded) {
        throw new NotFoundException("No file available");
      }
      await this.log(tx, p, "lms.content.download", contentId);
      return { key: row.fileKey, fileName: row.fileName ?? "material.pdf" };
    });
    return this.storage.presignDownload({ key: file.key, filename: file.fileName });
  }

  // --- approval workflow ----------------------------------------------------
  /** Author submits content for principal approval (creates/advances a workflow). */
  async submitForApproval(p: Principal, contentId: string): Promise<LmsContentDto> {
    // 1) validate + capture (own tx)
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, r.classId);
      if (r.status !== "DRAFT" && r.status !== "REVISION_REQUESTED") {
        throw new ConflictException("Only draft / revision-requested content can be submitted");
      }
      return r;
    });

    // 2) drive the workflow engine OUTSIDE the LMS tx (no nested transactions)
    let requestId = row.approvalRequestId;
    if (!requestId) {
      const req = await this.workflow.createRequest(p, {
        type: "LMS_CONTENT_PUBLISH",
        title: `Publish: ${row.title}`,
        payload: { contentId, classId: row.classId, contentType: row.type },
      });
      requestId = (req as { id: string }).id;
    }
    await this.workflow.submit(p, requestId);

    // 3) reflect on the content row
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: { approvalRequestId: requestId, status: "PENDING_APPROVAL" },
      })) as ContentRow;
      await this.log(tx, p, "lms.content.submit", contentId, { requestId });
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
    });
  }

  /** Principal reviews submitted content (APPROVE -> PUBLISHED, etc.). */
  async review(
    p: Principal,
    contentId: string,
    action: Extract<WorkflowAction, "APPROVE" | "REJECT" | "REQUEST_REVISION">,
    comments?: string,
  ): Promise<LmsContentDto> {
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await this.requireContent(tx, contentId);
      if (!r.approvalRequestId) throw new ConflictException("Content has not been submitted");
      if (r.status !== "PENDING_APPROVAL") throw new ConflictException("Content is not pending approval");
      return r;
    });

    // Drive the engine (enforces separation of duties: approver != author).
    await this.workflow.review(p, row.approvalRequestId!, action, comments);

    const status: LmsContentStatus =
      action === "APPROVE" ? "PUBLISHED" : action === "REJECT" ? "REJECTED" : "REVISION_REQUESTED";
    const { dto, recipients } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: { status },
      })) as ContentRow;
      await this.log(tx, p, "lms.content.review", contentId, { action, status });
      // On publish, resolve the audience (enrolled students + their guardians)
      // inside the tenant tx; the actual enqueue happens best-effort post-commit.
      const recipients = status === "PUBLISHED" ? await this.contentAudience(tx, row.classId) : [];
      return { dto: this.toDto(updated, true, await this.nameOf(tx, updated.authorId)), recipients };
    });

    if (recipients.length > 0) await this.notifyPublished(p, dto, recipients);
    return dto;
  }

  /** Enrolled students of a class + their linked guardians (de-duplicated). */
  private async contentAudience(tx: TenantTx, classId: string): Promise<string[]> {
    const enrolled = await tx.enrollment.findMany({ where: { classId }, select: { studentId: true } });
    const studentIds = enrolled.map((e: { studentId: string }) => e.studentId);
    const recipients = new Set<string>(studentIds);
    if (studentIds.length > 0) {
      const links = await tx.parentChild.findMany({
        where: { studentId: { in: studentIds } },
        select: { parentId: true },
      });
      for (const l of links) recipients.add(l.parentId);
    }
    return [...recipients];
  }

  /** Best-effort: alert each recipient that new content was published. */
  private async notifyPublished(p: Principal, dto: LmsContentDto, recipients: string[]): Promise<void> {
    for (const recipientId of recipients) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId,
          type: "ANNOUNCEMENT",
          title: "New learning content",
          body: `"${dto.title}" is now available in your class.`,
          data: { contentId: dto.id, classId: dto.classId, contentType: dto.type },
        });
      } catch (err) {
        this.logger.error(`LMS publish notification failed for ${recipientId}: ${String(err)}`);
      }
    }
  }

  /** The calling student's own quiz result (re-graded server-side), or null. */
  async myQuizResult(p: Principal, contentId: string): Promise<QuizAttemptResultDto | null> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "QUIZ") throw new BadRequestException("Not a quiz");
      await this.assertCanRead(tx, p, row);
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (!quiz) return null;
      const attempts = await tx.quizAttempt.findMany({
        where: { contentId, studentId: p.userId },
        orderBy: { attemptNo: "asc" },
        select: { answers: true, score: true, total: true, attemptNo: true, status: true },
      });
      if (attempts.length === 0) return null;
      const maxAttempts = quiz.maxAttempts && quiz.maxAttempts > 0 ? Math.floor(quiz.maxAttempts) : 1;
      // BEST (default) returns the highest-scoring attempt; LATEST the most recent.
      const chosen =
        quiz.scoring === "LATEST"
          ? attempts[attempts.length - 1]
          : attempts.reduce((a: (typeof attempts)[number], b: (typeof attempts)[number]) => (b.score > a.score ? b : a));
      // Objective correctness for display; the STORED score/total reflect any manual marks.
      const auto = gradeQuiz(this.pickForStudent(quiz, p.userId, contentId), (chosen.answers ?? {}) as Record<string, string>);
      return {
        score: chosen.score,
        total: chosen.total,
        correct: auto.correct,
        attemptsUsed: attempts.length,
        maxAttempts,
        pendingManual: chosen.status === "PENDING_MANUAL",
      };
    });
  }

  // --- reads (relationship + approval scoped) -------------------------------
  async listContent(p: Principal, classId: string): Promise<LmsContentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staff = await this.canAuthor(tx, p, classId);
      if (!staff) await this.assertEnrolledOrGuardian(tx, p, classId);
      if (staff) {
        // Reconcile any inbox-approved items before listing (safety net).
        const all = (await tx.lmsContent.findMany({ where: { classId } })) as ContentRow[];
        await this.reconcile(tx, all);
      }
      const where = staff
        ? { classId }
        : { classId, status: "PUBLISHED" }; // students/parents: published only
      const rows = (await tx.lmsContent.findMany({
        where,
        orderBy: { createdAt: "desc" },
      })) as ContentRow[];
      const names = await this.nameMap(tx, rows.map((r) => r.authorId));
      const done = staff ? new Set<string>() : await this.completedSet(tx, p.userId, rows.map((r) => r.id));
      const viewerId = staff ? undefined : p.userId;
      return rows.map((r) => this.toDto(r, staff, names.get(r.authorId) ?? "User", done.has(r.id), viewerId));
    });
  }

  async getContent(p: Principal, contentId: string): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.reconcile(tx, [row]);
      const staff = await this.assertCanRead(tx, p, row);
      const completed = staff ? false : (await this.completedSet(tx, p.userId, [row.id])).has(row.id);
      return this.toDto(row, staff, await this.nameOf(tx, row.authorId), completed, staff ? undefined : p.userId);
    });
  }

  /** The principal's approval queue: content awaiting review, school-wide. */
  async listPendingApprovals(p: Principal): Promise<LmsContentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const pending = (await tx.lmsContent.findMany({
        where: { status: "PENDING_APPROVAL" },
        orderBy: { createdAt: "asc" },
      })) as ContentRow[];
      await this.reconcile(tx, pending); // drop any already-decided via the inbox
      const still = pending.filter((r) => r.status === "PENDING_APPROVAL");
      const names = await this.nameMap(tx, still.map((r) => r.authorId));
      return still.map((r) => this.toDto(r, true, names.get(r.authorId) ?? "User"));
    });
  }

  // --- quiz attempt (enrolled student, one attempt, auto-graded) ------------
  async attemptQuiz(
    p: Principal,
    contentId: string,
    answers: Record<string, string>,
  ): Promise<QuizAttemptResultDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "QUIZ") throw new BadRequestException("Not a quiz");
      if (row.status !== "PUBLISHED") throw new ConflictException("Quiz is not published");
      await this.assertEnrolledOrGuardian(tx, p, row.classId, { studentOnly: true });
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (!quiz) throw new ConflictException("Quiz has no questions");
      // availability window
      const now = Date.now();
      if (quiz.opensAt && now < new Date(quiz.opensAt).getTime()) throw new ConflictException("This quiz isn't open yet");
      if (quiz.closesAt && now > new Date(quiz.closesAt).getTime()) throw new ConflictException("This quiz has closed");
      // attempt cap
      const maxAttempts = quiz.maxAttempts && quiz.maxAttempts > 0 ? Math.floor(quiz.maxAttempts) : 1;
      const used = await tx.quizAttempt.count({ where: { contentId, studentId: p.userId } });
      if (used >= maxAttempts) throw new ConflictException("You have no attempts left for this quiz");
      // Grade over the student's deterministic question subset (question-bank).
      const picked = this.pickForStudent(quiz, p.userId, contentId);
      const result = gradeQuiz(picked, answers ?? {});
      const hasEssays = picked.questions.some((q) => q.type === "ESSAY");
      await tx.quizAttempt.create({
        data: {
          schoolId: p.schoolId,
          contentId,
          studentId: p.userId,
          answers: (answers ?? {}) as Prisma.InputJsonValue,
          score: result.score, // auto (objective) score; essays add on manual marking
          total: result.total,
          attemptNo: used + 1,
          status: hasEssays ? "PENDING_MANUAL" : "GRADED",
        },
      });
      await this.emitStatement(tx, p, {
        // "passed"/"failed" once auto-graded (≥50%); "attempted" while essays await marking.
        verb: hasEssays ? "attempted" : result.score / Math.max(1, result.total) >= 0.5 ? "passed" : "failed",
        objectId: `quiz:${contentId}`,
        objectName: row.title,
        classId: row.classId,
        result: { score: result.score, max: result.total, success: hasEssays ? null : result.score / Math.max(1, result.total) >= 0.5, completion: !hasEssays },
      });
      await this.log(tx, p, "lms.quiz.attempt", contentId, { score: result.score, total: result.total, attemptNo: used + 1 });
      return { ...result, attemptsUsed: used + 1, maxAttempts, pendingManual: hasEssays };
    });
  }

  // --- essay grading (teacher marks the essay questions in each attempt) -----
  /** Build a grading DTO for one attempt (essays from the student's own subset). */
  private toAttemptGradeDto(
    a: { id: string; studentId: string; attemptNo: number; status: string; score: number; total: number; answers: Prisma.JsonValue; essayGrades: Prisma.JsonValue },
    quiz: QuizDefDto,
    contentId: string,
    studentName: string,
  ): QuizAttemptGradeDto {
    const picked = this.pickForStudent(quiz, a.studentId, contentId);
    const answers = (a.answers ?? {}) as Record<string, string>;
    const grades = (a.essayGrades ?? {}) as Record<string, number>;
    const auto = gradeQuiz(picked, answers);
    const essays = picked.questions
      .filter((q) => q.type === "ESSAY")
      .map((q) => ({
        questionId: q.id,
        prompt: q.prompt,
        answer: answers[q.id] ?? "",
        points: q.points && q.points > 0 ? q.points : 1,
        grade: grades[q.id] ?? null,
      }));
    return {
      attemptId: a.id,
      studentId: a.studentId,
      studentName,
      attemptNo: a.attemptNo,
      status: a.status === "PENDING_MANUAL" ? "PENDING_MANUAL" : "GRADED",
      autoScore: auto.score,
      score: a.score,
      total: a.total,
      essays,
    };
  }

  /** Teacher-of-class lists all attempts (with essays to mark). */
  async listQuizAttempts(p: Principal, contentId: string): Promise<QuizAttemptGradeDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "QUIZ") throw new BadRequestException("Not a quiz");
      await this.assertTeacherOfClass(tx, p, row.classId);
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (!quiz) return [];
      const attempts = await tx.quizAttempt.findMany({
        where: { contentId },
        orderBy: [{ studentId: "asc" }, { attemptNo: "asc" }],
      });
      const names = await this.nameMap(tx, attempts.map((a: { studentId: string }) => a.studentId));
      return attempts.map((a: Parameters<typeof this.toAttemptGradeDto>[0]) =>
        this.toAttemptGradeDto(a, quiz, contentId, names.get(a.studentId) ?? "Student"),
      );
    });
  }

  /** Teacher marks the essay questions of one attempt; recomputes the total. */
  async gradeQuizEssays(p: Principal, attemptId: string, grades: Record<string, number>): Promise<QuizAttemptGradeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.quizAttempt.findFirst({ where: { id: attemptId } });
      if (!a) throw new NotFoundException("Attempt not found");
      const row = await this.requireContent(tx, a.contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (!quiz) throw new ConflictException("Quiz has no questions");
      const picked = this.pickForStudent(quiz, a.studentId, a.contentId);
      const essayQs = picked.questions.filter((q) => q.type === "ESSAY");
      const finalGrades: Record<string, number> = {};
      let essaySum = 0;
      for (const q of essayQs) {
        const g = (grades ?? {})[q.id];
        if (g == null) continue; // ungraded essay → stays pending
        const max = q.points && q.points > 0 ? q.points : 1;
        const v = Math.floor(g);
        if (v < 0 || v > max) throw new BadRequestException(`Grade must be between 0 and ${max}`);
        finalGrades[q.id] = v;
        essaySum += v;
      }
      const auto = gradeQuiz(picked, (a.answers ?? {}) as Record<string, string>);
      const allGraded = essayQs.every((q) => finalGrades[q.id] != null);
      const updated = await tx.quizAttempt.update({
        where: { id: attemptId },
        data: {
          essayGrades: finalGrades as Prisma.InputJsonValue,
          score: auto.score + essaySum,
          status: allGraded ? "GRADED" : "PENDING_MANUAL",
        },
      });
      await this.log(tx, p, "lms.quiz.essay.grade", attemptId, { score: auto.score + essaySum });
      return this.toAttemptGradeDto(updated, quiz, a.contentId, await this.nameOf(tx, a.studentId));
    });
  }

  // --- progress / completion ------------------------------------------------
  /** An enrolled student marks a PUBLISHED item complete (idempotent). */
  async markComplete(p: Principal, contentId: string): Promise<{ completed: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.status !== "PUBLISHED") throw new ConflictException("Content is not published");
      await this.assertEnrolledOrGuardian(tx, p, row.classId, { studentOnly: true });
      await tx.lmsProgress.upsert({
        where: { contentId_studentId: { contentId, studentId: p.userId } },
        create: { schoolId: p.schoolId, contentId, studentId: p.userId, status: "COMPLETED" },
        update: { status: "COMPLETED", completedAt: new Date() },
      });
      await this.emitStatement(tx, p, {
        verb: "completed",
        objectId: `content:${contentId}`,
        objectName: row.title,
        classId: row.classId,
        result: { completion: true },
      });
      await this.log(tx, p, "lms.content.complete", contentId);
      return { completed: true };
    });
  }

  /** The student un-marks the item (progress isn't an audit record). */
  async unmarkComplete(p: Principal, contentId: string): Promise<{ completed: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertEnrolledOrGuardian(tx, p, row.classId, { studentOnly: true });
      await tx.lmsProgress.deleteMany({ where: { contentId, studentId: p.userId } });
      await this.log(tx, p, "lms.content.uncomplete", contentId);
      return { completed: false };
    });
  }

  /** Teacher-of-class (or school-wide staff) sees per-student completion counts. */
  async classProgress(p: Principal, classId: string): Promise<ClassProgressDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId); // 404 if not staff-of-class
      const published = (
        await tx.lmsContent.findMany({ where: { classId, status: "PUBLISHED" }, select: { id: true } })
      ).map((c: { id: string }) => c.id);
      const enrolments = await tx.enrollment.findMany({
        where: { classId, status: "ACTIVE" },
        select: { studentId: true },
      });
      const studentIds = enrolments.map((e: { studentId: string }) => e.studentId);
      const names = await this.nameMap(tx, studentIds);
      const progress =
        published.length && studentIds.length
          ? await tx.lmsProgress.findMany({
              where: { contentId: { in: published }, studentId: { in: studentIds }, status: "COMPLETED" },
              select: { studentId: true },
            })
          : [];
      const count = new Map<string, number>();
      for (const pr of progress as { studentId: string }[]) {
        count.set(pr.studentId, (count.get(pr.studentId) ?? 0) + 1);
      }
      await this.log(tx, p, "lms.content.progress.read", classId, { students: studentIds.length });
      return {
        totalPublished: published.length,
        students: studentIds
          .map((sid) => ({ studentId: sid, studentName: names.get(sid) ?? "Student", completed: count.get(sid) ?? 0 }))
          .sort((a, b) => b.completed - a.completed || a.studentName.localeCompare(b.studentName)),
      };
    });
  }

  // --- modules (group content into an ordered learning path) ----------------
  async createModule(p: Principal, classId: string, title: string): Promise<LmsModuleDto> {
    const t = (title ?? "").trim();
    if (!t) throw new BadRequestException("Module title is required");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId);
      const agg = await tx.lmsModule.aggregate({ where: { classId }, _max: { orderIndex: true } });
      const orderIndex = (agg._max.orderIndex ?? -1) + 1;
      const m = await tx.lmsModule.create({ data: { schoolId: p.schoolId, classId, title: t, orderIndex } });
      await this.log(tx, p, "lms.module.create", m.id, { classId });
      return { id: m.id, classId: m.classId, title: m.title, orderIndex: m.orderIndex };
    });
  }

  async listModules(p: Principal, classId: string): Promise<LmsModuleDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staff = await this.canAuthor(tx, p, classId);
      if (!staff) await this.assertEnrolledOrGuardian(tx, p, classId);
      const mods = await tx.lmsModule.findMany({ where: { classId }, orderBy: { orderIndex: "asc" } });
      return mods.map((m: { id: string; classId: string; title: string; orderIndex: number }) => ({
        id: m.id,
        classId: m.classId,
        title: m.title,
        orderIndex: m.orderIndex,
      }));
    });
  }

  async renameModule(p: Principal, moduleId: string, title: string): Promise<LmsModuleDto> {
    const t = (title ?? "").trim();
    if (!t) throw new BadRequestException("Module title is required");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const m = await tx.lmsModule.findFirst({ where: { id: moduleId } });
      if (!m) throw new NotFoundException("Module not found");
      await this.assertTeacherOfClass(tx, p, m.classId);
      const u = await tx.lmsModule.update({ where: { id: moduleId }, data: { title: t } });
      await this.log(tx, p, "lms.module.rename", moduleId);
      return { id: u.id, classId: u.classId, title: u.title, orderIndex: u.orderIndex };
    });
  }

  async deleteModule(p: Principal, moduleId: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const m = await tx.lmsModule.findFirst({ where: { id: moduleId } });
      if (!m) throw new NotFoundException("Module not found");
      await this.assertTeacherOfClass(tx, p, m.classId);
      await tx.lmsContent.updateMany({ where: { moduleId }, data: { moduleId: null } }); // ungroup its content
      await tx.lmsModule.delete({ where: { id: moduleId } });
      await this.log(tx, p, "lms.module.delete", moduleId);
      return { deleted: true };
    });
  }

  /** Move a content item into a module (or out, moduleId=null). */
  async assignContentModule(p: Principal, contentId: string, moduleId: string | null): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (moduleId) {
        const m = await tx.lmsModule.findFirst({ where: { id: moduleId } });
        if (!m) throw new NotFoundException("Module not found");
        if (m.classId !== row.classId) throw new BadRequestException("Module belongs to a different class");
      }
      const updated = (await tx.lmsContent.update({ where: { id: contentId }, data: { moduleId } })) as ContentRow;
      await this.log(tx, p, "lms.content.assign_module", contentId, { moduleId });
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
    });
  }

  // --- assignments (student submits text; staff grades) ---------------------
  /** Enrolled student submits/updates their work for a PUBLISHED assignment. */
  async submitAssignment(p: Principal, contentId: string, text: string): Promise<LmsSubmissionDto> {
    const body = (text ?? "").trim();
    if (!body) throw new BadRequestException("Your submission is empty");
    if (body.length > 50000) throw new BadRequestException("Submission too long");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "ASSIGNMENT") throw new BadRequestException("Not an assignment");
      if (row.status !== "PUBLISHED") throw new ConflictException("Assignment is not published");
      await this.assertEnrolledOrGuardian(tx, p, row.classId, { studentOnly: true });
      const existing = await tx.lmsSubmission.findFirst({
        where: { contentId, studentId: p.userId },
        select: { id: true, status: true },
      });
      if (existing?.status === "GRADED") throw new ConflictException("This submission has already been graded");
      const assignment = row.body as unknown as { dueAt?: string };
      const late = assignment.dueAt ? Date.now() > new Date(assignment.dueAt).getTime() : false;
      const saved = existing
        ? await tx.lmsSubmission.update({ where: { id: existing.id }, data: { text: body, late, submittedAt: new Date() } })
        : await tx.lmsSubmission.create({
            data: { schoolId: p.schoolId, contentId, studentId: p.userId, text: body, late, status: "SUBMITTED" },
          });
      await this.log(tx, p, "lms.assignment.submit", contentId, { late });
      return this.toSubmissionDto(saved, await this.nameOf(tx, p.userId));
    });
  }

  /** A student's own submission (or null). */
  async mySubmission(p: Principal, contentId: string): Promise<LmsSubmissionDto | null> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertCanRead(tx, p, row);
      const sub = await tx.lmsSubmission.findFirst({ where: { contentId, studentId: p.userId } });
      return sub ? this.toSubmissionDto(sub, await this.nameOf(tx, p.userId)) : null;
    });
  }

  /** Teacher-of-class sees every submission for the assignment. */
  async listSubmissions(p: Principal, contentId: string): Promise<LmsSubmissionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId); // 404 if not staff-of-class
      const subs = await tx.lmsSubmission.findMany({ where: { contentId }, orderBy: { submittedAt: "asc" } });
      const names = await this.nameMap(tx, subs.map((s: { studentId: string }) => s.studentId));
      return subs.map((s: SubmissionRow) => this.toSubmissionDto(s, names.get(s.studentId) ?? "Student"));
    });
  }

  /** Teacher grades a submission (mark + feedback). */
  async gradeSubmission(
    p: Principal,
    submissionId: string,
    input: { grade: number; feedback?: string },
  ): Promise<LmsSubmissionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sub = (await tx.lmsSubmission.findFirst({ where: { id: submissionId } })) as SubmissionRow | null;
      if (!sub) throw new NotFoundException("Submission not found");
      const content = await this.requireContent(tx, sub.contentId);
      await this.assertTeacherOfClass(tx, p, content.classId);
      const max = (content.body as unknown as { points?: number }).points;
      const grade = Math.floor(input.grade);
      if (grade < 0 || (typeof max === "number" && grade > max)) {
        throw new BadRequestException(`Grade must be between 0 and ${typeof max === "number" ? max : "the max"}`);
      }
      const updated = (await tx.lmsSubmission.update({
        where: { id: submissionId },
        data: {
          grade,
          feedback: (input.feedback ?? "").trim() || null,
          status: "GRADED",
          gradedById: p.userId,
          gradedAt: new Date(),
        },
      })) as SubmissionRow;
      await this.log(tx, p, "lms.assignment.grade", submissionId, { grade });
      return this.toSubmissionDto(updated, await this.nameOf(tx, updated.studentId));
    });
  }

  private toSubmissionDto(s: SubmissionRow, studentName: string): LmsSubmissionDto {
    return {
      id: s.id,
      contentId: s.contentId,
      studentId: s.studentId,
      studentName,
      text: s.text,
      status: s.status as LmsSubmissionDto["status"],
      grade: s.grade,
      feedback: s.feedback,
      late: s.late,
      submittedAt: s.submittedAt,
      gradedAt: s.gradedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Learning analytics (teacher dashboard; staff-of-class only)
  // ---------------------------------------------------------------------------
  /** Per-class learning analytics — completion, quiz/assignment performance,
   *  live attendance, and a per-student engagement roll-up. All figures are
   *  SIGNALS for the teacher, never an automated verdict (Golden Rule #8). */
  async classAnalytics(p: Principal, classId: string): Promise<LmsAnalyticsDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId); // 404 if not staff-of-class
      const contents = (await tx.lmsContent.findMany({
        where: { classId, status: "PUBLISHED" },
        select: { id: true, type: true, title: true, body: true },
      })) as { id: string; type: string; title: string; body: Prisma.JsonValue }[];
      const publishedIds = contents.map((c) => c.id);
      const quizContents = contents.filter((c) => c.type === "QUIZ");
      const assignmentContents = contents.filter((c) => c.type === "ASSIGNMENT");

      const enrolments = await tx.enrollment.findMany({
        where: { classId, status: "ACTIVE" },
        select: { studentId: true },
      });
      const studentIds = enrolments.map((e) => e.studentId);
      const names = await this.nameMap(tx, studentIds);
      const studentCount = studentIds.length;

      const typeCount = new Map<string, number>();
      for (const c of contents) typeCount.set(c.type, (typeCount.get(c.type) ?? 0) + 1);
      const contentByType = [...typeCount.entries()].map(([type, count]) => ({ type: type as LmsContentType, count }));

      // Completion per student (COMPLETED progress rows over published content).
      const progressRows =
        publishedIds.length && studentCount
          ? await tx.lmsProgress.findMany({
              where: { contentId: { in: publishedIds }, studentId: { in: studentIds }, status: "COMPLETED" },
              select: { studentId: true },
            })
          : [];
      const completedByStudent = new Map<string, number>();
      for (const r of progressRows) completedByStudent.set(r.studentId, (completedByStudent.get(r.studentId) ?? 0) + 1);

      // Quiz performance — best score % per (quiz, student).
      const quizIds = quizContents.map((c) => c.id);
      const attempts =
        quizIds.length && studentCount
          ? await tx.quizAttempt.findMany({
              where: { contentId: { in: quizIds }, studentId: { in: studentIds } },
              select: { contentId: true, studentId: true, score: true, total: true },
            })
          : [];
      const bestByKey = new Map<string, number>();
      const quizzesTakenByStudent = new Map<string, Set<string>>();
      for (const a of attempts) {
        (quizzesTakenByStudent.get(a.studentId) ?? quizzesTakenByStudent.set(a.studentId, new Set()).get(a.studentId)!).add(a.contentId);
        if (a.total <= 0) continue;
        const pct = (a.score / a.total) * 100;
        const k = `${a.contentId}:${a.studentId}`;
        const prev = bestByKey.get(k);
        if (prev === undefined || pct > prev) bestByKey.set(k, pct);
      }
      const quizzes = quizContents.map((c) => {
        const percents: number[] = [];
        for (const sid of studentIds) {
          const v = bestByKey.get(`${c.id}:${sid}`);
          if (v !== undefined) percents.push(v);
        }
        const avg = percents.length ? Math.round(percents.reduce((s, v) => s + v, 0) / percents.length) : null;
        return { contentId: c.id, title: c.title, studentsAttempted: percents.length, avgPercent: avg };
      });

      // Assignment performance — submitted / graded / avg grade %.
      const maxByAssignment = new Map<string, number | undefined>();
      for (const c of assignmentContents) {
        const pts = (c.body as unknown as { points?: number }).points;
        maxByAssignment.set(c.id, typeof pts === "number" && pts > 0 ? pts : undefined);
      }
      const assignmentIds = assignmentContents.map((c) => c.id);
      const submissions =
        assignmentIds.length && studentCount
          ? await tx.lmsSubmission.findMany({
              where: { contentId: { in: assignmentIds }, studentId: { in: studentIds } },
              select: { contentId: true, studentId: true, status: true, grade: true },
            })
          : [];
      const subsByContent = new Map<string, { status: string; grade: number | null }[]>();
      const submittedByStudent = new Map<string, Set<string>>();
      for (const s of submissions) {
        (subsByContent.get(s.contentId) ?? subsByContent.set(s.contentId, []).get(s.contentId)!).push(s);
        (submittedByStudent.get(s.studentId) ?? submittedByStudent.set(s.studentId, new Set()).get(s.studentId)!).add(s.contentId);
      }
      const assignments = assignmentContents.map((c) => {
        const subs = subsByContent.get(c.id) ?? [];
        const graded = subs.filter((s) => s.status === "GRADED" && s.grade !== null);
        const max = maxByAssignment.get(c.id);
        const avg =
          max && graded.length
            ? Math.round(graded.reduce((s, g) => s + ((g.grade as number) / max) * 100, 0) / graded.length)
            : null;
        return { contentId: c.id, title: c.title, submitted: subs.length, graded: graded.length, avgPercent: avg };
      });

      // Live attendance.
      const liveSessions = await tx.lmsLiveSession.findMany({ where: { classId }, select: { id: true } });
      const liveIds = liveSessions.map((s) => s.id);
      const liveAtt = liveIds.length
        ? await tx.lmsLiveAttendance.findMany({ where: { sessionId: { in: liveIds } }, select: { sessionId: true, studentId: true } })
        : [];
      const liveJoinedByStudent = new Map<string, Set<string>>();
      for (const a of liveAtt) {
        (liveJoinedByStudent.get(a.studentId) ?? liveJoinedByStudent.set(a.studentId, new Set()).get(a.studentId)!).add(a.sessionId);
      }

      // Per-student engagement roll-up + class completion average.
      let completionSum = 0;
      let fullyComplete = 0;
      const engagement = studentIds
        .map((sid) => {
          const completed = completedByStudent.get(sid) ?? 0;
          const quizzesTaken = quizzesTakenByStudent.get(sid)?.size ?? 0;
          const assignmentsSubmitted = submittedByStudent.get(sid)?.size ?? 0;
          const liveJoined = liveJoinedByStudent.get(sid)?.size ?? 0;
          completionSum += publishedIds.length ? completed / publishedIds.length : 0;
          if (publishedIds.length && completed >= publishedIds.length) fullyComplete++;
          const engagementPercent = computeEngagementPercent([
            { value: completed, total: publishedIds.length },
            { value: quizzesTaken, total: quizContents.length },
            { value: assignmentsSubmitted, total: assignmentContents.length },
            { value: liveJoined, total: liveIds.length },
          ]);
          return { studentId: sid, studentName: names.get(sid) ?? "Student", completed, quizzesTaken, assignmentsSubmitted, liveJoined, engagementPercent };
        })
        .sort((a, b) => a.engagementPercent - b.engagementPercent || a.studentName.localeCompare(b.studentName));

      await this.log(tx, p, "lms.analytics.read", classId, { students: studentCount });
      return {
        classId,
        studentCount,
        publishedContent: publishedIds.length,
        contentByType,
        completion: { avgPercent: studentCount ? Math.round((completionSum / studentCount) * 100) : 0, fullyComplete },
        quizzes,
        assignments,
        live: { sessions: liveIds.length, totalJoins: liveAtt.length },
        engagement,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Engagement — achievement badges (positive recognition; teacher-awarded)
  // ---------------------------------------------------------------------------
  /** Award a badge to an enrolled student (teacher-of-class). Human-in-the-loop
   *  positive recognition — never automated, never punitive (Golden Rule #8).
   *  The student is notified (best-effort). */
  async awardBadge(
    p: Principal,
    classId: string,
    input: { studentId: string; badge: string; note?: string },
  ): Promise<LmsAwardDto> {
    if (!isBadgeKey(input.badge)) throw new BadRequestException("unknown badge");
    const note = (input.note ?? "").trim() || null;
    const created = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId);
      const enrolled = await tx.enrollment.findFirst({
        where: { classId, studentId: input.studentId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!enrolled) throw new NotFoundException("Student is not enrolled in this class");
      const row = await tx.lmsAward.create({
        data: { schoolId: p.schoolId, classId, studentId: input.studentId, badge: input.badge, note, awardedById: p.userId },
      });
      await this.log(tx, p, "lms.award.grant", row.id, { classId, studentId: input.studentId, badge: input.badge });
      return { row, studentName: await this.nameOf(tx, input.studentId), awardedByName: await this.nameOf(tx, p.userId) };
    });
    try {
      const meta = badgeMeta(created.row.badge);
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: input.studentId,
        type: "ANNOUNCEMENT",
        title: `You earned a badge: ${meta.icon} ${meta.label}`,
        body: note ?? meta.description,
        data: { classId, badge: created.row.badge },
      });
    } catch (err) {
      this.logger.error(`LMS award notification failed: ${String(err)}`);
    }
    return this.toAwardDto(created.row, created.studentName, created.awardedByName);
  }

  /** A class's awards. Relationship-scoped: staff-of-class → all; enrolled
   *  student → own; guardian → their children's. */
  async listAwards(p: Principal, classId: string): Promise<LmsAwardDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staff = await this.canAuthor(tx, p, classId);
      let where: Prisma.LmsAwardWhereInput = { classId };
      if (!staff) {
        await this.assertEnrolledOrGuardian(tx, p, classId);
        const enrolled = await tx.enrollment.findFirst({
          where: { classId, studentId: p.userId },
          select: { id: true },
        });
        if (enrolled) {
          where = { classId, studentId: p.userId };
        } else {
          const children = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
          where = { classId, studentId: { in: children.map((c) => c.studentId) } };
        }
      }
      const rows = await tx.lmsAward.findMany({ where, orderBy: { createdAt: "desc" } });
      const names = await this.nameMap(tx, [...rows.map((r) => r.studentId), ...rows.map((r) => r.awardedById)]);
      return rows.map((r) => this.toAwardDto(r, names.get(r.studentId) ?? "Student", names.get(r.awardedById) ?? "Teacher"));
    });
  }

  /** Revoke a mistaken award (teacher-of-class). */
  async revokeAward(p: Principal, awardId: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.lmsAward.findFirst({ where: { id: awardId } });
      if (!a) throw new NotFoundException("Award not found");
      await this.assertTeacherOfClass(tx, p, a.classId); // 404 if not staff-of-class
      await tx.lmsAward.delete({ where: { id: awardId } });
      await this.log(tx, p, "lms.award.revoke", awardId, { classId: a.classId, studentId: a.studentId, badge: a.badge });
      return { deleted: true };
    });
  }

  private toAwardDto(
    r: { id: string; classId: string; studentId: string; badge: string; note: string | null; createdAt: Date },
    studentName: string,
    awardedByName: string,
  ): LmsAwardDto {
    return {
      id: r.id,
      classId: r.classId,
      studentId: r.studentId,
      studentName,
      badge: r.badge,
      note: r.note,
      awardedByName,
      createdAt: r.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // xAPI (Tin Can) Learning Record Store — record + query learning statements
  // ---------------------------------------------------------------------------
  /** Internal emit: append an xAPI statement in the SAME tenant tx as the action
   *  that produced it. Actor is ALWAYS the acting principal. */
  private async emitStatement(
    tx: TenantTx,
    p: Principal,
    s: { verb: XapiVerb; objectId: string; objectName: string; classId: string | null; result?: XapiResult },
  ): Promise<void> {
    await tx.xapiStatement.create({
      data: {
        schoolId: p.schoolId,
        actorId: p.userId,
        verb: s.verb,
        objectId: s.objectId,
        objectName: s.objectName,
        classId: s.classId,
        result: (s.result ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Record a learning statement (from an external xAPI/SCORM activity, or the
   *  client). SECURITY: the actor is the verified caller — never trusted from the
   *  body, so a student can only record their OWN activity. A class-scoped
   *  statement requires the caller be enrolled in / staff of that class. */
  async recordStatement(
    p: Principal,
    input: { verb: string; objectId: string; objectName: string; classId?: string; result?: unknown },
  ): Promise<XapiStatementDto> {
    if (!isXapiVerb(input.verb)) throw new BadRequestException("unknown xAPI verb");
    const objectId = (input.objectId ?? "").trim();
    const objectName = (input.objectName ?? "").trim();
    if (!objectId || !objectName) throw new BadRequestException("objectId and objectName are required");
    const result = normalizeXapiResult(input.result);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let classId: string | null = null;
      if (input.classId) {
        // Caller must belong to the class (staff-of-class or enrolled/guardian) — 404 otherwise.
        const staff = await this.canAuthor(tx, p, input.classId);
        if (!staff) await this.assertEnrolledOrGuardian(tx, p, input.classId);
        classId = input.classId;
      }
      const row = await tx.xapiStatement.create({
        data: { schoolId: p.schoolId, actorId: p.userId, verb: input.verb, objectId, objectName, classId, result: result as Prisma.InputJsonValue },
      });
      await this.log(tx, p, "lms.xapi.record", row.id, { verb: input.verb, objectId });
      return this.toXapiDto(row, await this.nameOf(tx, row.actorId));
    });
  }

  /** Query the LRS. Relationship-scoped: staff-of-class → all statements for the
   *  class (optionally one student); everyone else → their OWN statements. */
  async listStatements(
    p: Principal,
    q: { classId?: string; studentId?: string },
  ): Promise<XapiStatementDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let where: Prisma.XapiStatementWhereInput;
      if (q.classId && (await this.canAuthor(tx, p, q.classId))) {
        where = { classId: q.classId, ...(q.studentId ? { actorId: q.studentId } : {}) };
      } else {
        // Non-staff (or no class): only your own record.
        where = { actorId: p.userId, ...(q.classId ? { classId: q.classId } : {}) };
      }
      const rows = await tx.xapiStatement.findMany({ where, orderBy: { storedAt: "desc" }, take: 500 });
      const names = await this.nameMap(tx, rows.map((r) => r.actorId));
      return rows.map((r) => this.toXapiDto(r, names.get(r.actorId) ?? "User"));
    });
  }

  private toXapiDto(
    r: { id: string; actorId: string; verb: string; objectId: string; objectName: string; classId: string | null; result: Prisma.JsonValue; storedAt: Date },
    actorName: string,
  ): XapiStatementDto {
    return {
      id: r.id,
      actorId: r.actorId,
      actorName,
      verb: r.verb as XapiVerb,
      objectId: r.objectId,
      objectName: r.objectName,
      classId: r.classId,
      result: (r.result ?? {}) as unknown as XapiResult,
      storedAt: r.storedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Version history (append-only) + revert + clone (reuse)
  // ---------------------------------------------------------------------------
  /** Append a snapshot of the content's current title/body to its version
   *  history. Called after every create/edit/revert; version is sequential. */
  private async snapshot(tx: TenantTx, p: Principal, row: ContentRow, note: string): Promise<void> {
    const version = (await tx.lmsContentRevision.count({ where: { contentId: row.id } })) + 1;
    await tx.lmsContentRevision.create({
      data: {
        schoolId: p.schoolId,
        contentId: row.id,
        version,
        type: row.type,
        title: row.title,
        body: row.body as Prisma.InputJsonValue,
        note,
        authorId: p.userId,
      },
    });
  }

  /** The content's version history, newest first (staff-of-class only). */
  async listRevisions(p: Principal, contentId: string): Promise<LmsRevisionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId); // 404 if not staff-of-class
      const revs = await tx.lmsContentRevision.findMany({ where: { contentId }, orderBy: { version: "desc" } });
      const names = await this.nameMap(tx, revs.map((r) => r.authorId));
      return revs.map((r) => this.toRevisionDto(r, names.get(r.authorId) ?? "User"));
    });
  }

  /** Restore a past revision's title/body onto the (editable) content. The
   *  current state is snapshotted first, so revert is non-destructive + logged. */
  async revertToRevision(p: Principal, contentId: string, revisionId: string): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (row.status !== "DRAFT" && row.status !== "REVISION_REQUESTED") {
        throw new ConflictException("Only draft / revision-requested content can be reverted");
      }
      const rev = await tx.lmsContentRevision.findFirst({ where: { id: revisionId, contentId } });
      if (!rev) throw new NotFoundException("Revision not found");
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: { title: rev.title, body: rev.body as Prisma.InputJsonValue },
      })) as ContentRow;
      await this.snapshot(tx, p, updated, `Reverted to v${rev.version}`);
      await this.log(tx, p, "lms.content.revert", contentId, { toVersion: rev.version });
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
    });
  }

  /** Clone an existing content item into a class (default: the same class) as a
   *  fresh DRAFT — the reuse primitive. Relationship-scoped: the caller must be
   *  able to author BOTH the source and the target class. Approval state is
   *  stripped; a cross-class clone drops the module + gradebook tag (the subject
   *  may not be offered there). */
  async cloneContent(p: Principal, contentId: string, targetClassId?: string): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const src = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, src.classId); // must be able to author the source
      const targetClass = targetClassId ?? src.classId;
      if (targetClass !== src.classId) await this.assertTeacherOfClass(tx, p, targetClass);
      const sameClass = targetClass === src.classId;
      const row = (await tx.lmsContent.create({
        data: {
          schoolId: p.schoolId,
          classId: targetClass,
          type: src.type,
          title: `${src.title} (copy)`,
          body: src.body as Prisma.InputJsonValue,
          status: "DRAFT",
          authorId: p.userId,
          fileKey: src.fileKey,
          fileName: src.fileName,
          fileUploaded: src.fileUploaded,
          moduleId: sameClass ? src.moduleId : null,
          subjectId: sameClass ? src.subjectId : null,
          termId: sameClass ? src.termId : null,
        },
      })) as ContentRow;
      await this.snapshot(tx, p, row, `Cloned from "${src.title}"`);
      await this.log(tx, p, "lms.content.clone", row.id, { sourceId: contentId, targetClassId: targetClass });
      return this.toDto(row, true, await this.nameOf(tx, row.authorId));
    });
  }

  private toRevisionDto(
    r: { id: string; contentId: string; version: number; title: string; note: string | null; createdAt: Date },
    authorName: string,
  ): LmsRevisionDto {
    return {
      id: r.id,
      contentId: r.contentId,
      version: r.version,
      title: r.title,
      authorName,
      note: r.note,
      createdAt: r.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Live classroom — scheduled sessions (Zoom/Meet/Jitsi) + attendance
  // ---------------------------------------------------------------------------
  /** Schedule a live session for a class (teacher-of-class / school-wide). The
   *  join URL is validated to https + host-allowlisted per provider. */
  async createLiveSession(
    p: Principal,
    classId: string,
    input: { title: string; provider: LiveProvider; joinUrl: string; startsAt: string; durationMinutes?: number },
  ): Promise<LmsLiveSessionDto> {
    if (!["ZOOM", "MEET", "JITSI", "OTHER"].includes(input.provider)) throw new BadRequestException("invalid provider");
    const joinUrl = normalizeJoinUrl(input.provider, input.joinUrl);
    if (!joinUrl) throw new BadRequestException("Join link must be a valid https URL for the selected provider");
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException("invalid start time");
    const durationMinutes =
      typeof input.durationMinutes === "number" && input.durationMinutes > 0 ? Math.floor(input.durationMinutes) : 60;
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, classId);
      const row = await tx.lmsLiveSession.create({
        data: { schoolId: p.schoolId, classId, title, provider: input.provider, joinUrl, startsAt, durationMinutes, hostId: p.userId },
      });
      await this.log(tx, p, "lms.live.create", row.id, { classId, provider: input.provider });
      return this.toLiveDto(row, await this.nameOf(tx, row.hostId), 0);
    });
  }

  /** A class's live sessions, newest first. Relationship-scoped like content
   *  (staff/teacher-of-class → all + attendee counts; enrolled student/guardian
   *  → all, no counts). */
  async listLiveSessions(p: Principal, classId: string): Promise<LmsLiveSessionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staff = await this.canAuthor(tx, p, classId);
      if (!staff) await this.assertEnrolledOrGuardian(tx, p, classId);
      const rows = await tx.lmsLiveSession.findMany({ where: { classId }, orderBy: { startsAt: "desc" } });
      const names = await this.nameMap(tx, rows.map((r) => r.hostId));
      const counts = new Map<string, number>();
      if (staff && rows.length) {
        const grouped = await tx.lmsLiveAttendance.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        });
        for (const g of grouped) counts.set(g.sessionId, g._count._all);
      }
      return rows.map((r) => this.toLiveDto(r, names.get(r.hostId) ?? "Host", staff ? counts.get(r.id) ?? 0 : 0));
    });
  }

  /** Reveal the join URL (and record attendance for an enrolled student). The
   *  server gates the join window — a link is never handed out before/after. */
  async joinLiveSession(p: Principal, sessionId: string): Promise<{ joinUrl: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const s = await tx.lmsLiveSession.findFirst({ where: { id: sessionId } });
      if (!s) throw new NotFoundException("Session not found");
      const staff = await this.canAuthor(tx, p, s.classId);
      const isHost = s.hostId === p.userId;
      if (!staff && !isHost) await this.assertEnrolledOrGuardian(tx, p, s.classId, { studentOnly: true });
      if (!isJoinable(s.status, s.startsAt, s.durationMinutes)) {
        throw new ConflictException("This session isn't open to join right now.");
      }
      // Record attendance for an enrolled STUDENT only (never host/staff/guardian).
      if (!staff && !isHost) {
        const enrolled = await tx.enrollment.findFirst({
          where: { classId: s.classId, studentId: p.userId },
          select: { id: true },
        });
        if (enrolled) {
          const existing = await tx.lmsLiveAttendance.findFirst({
            where: { sessionId, studentId: p.userId },
            select: { id: true },
          });
          if (!existing) {
            await tx.lmsLiveAttendance.create({ data: { schoolId: p.schoolId, sessionId, studentId: p.userId } });
          }
        }
      }
      await this.log(tx, p, "lms.live.join", sessionId);
      return { joinUrl: s.joinUrl };
    });
  }

  /** Update a session (host or staff-of-class) — reschedule, change link, or
   *  transition status (SCHEDULED→LIVE→ENDED, or CANCELLED). */
  async updateLiveSession(
    p: Principal,
    sessionId: string,
    input: { status?: LiveStatus; title?: string; joinUrl?: string; startsAt?: string; durationMinutes?: number },
  ): Promise<LmsLiveSessionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const s = await tx.lmsLiveSession.findFirst({ where: { id: sessionId } });
      if (!s) throw new NotFoundException("Session not found");
      const staff = await this.canAuthor(tx, p, s.classId);
      if (!staff && s.hostId !== p.userId) throw new NotFoundException("Session not found"); // 404, not 403
      const data: Prisma.LmsLiveSessionUpdateInput = {};
      if (input.status && ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"].includes(input.status)) data.status = input.status;
      if (input.title !== undefined) {
        const t = (input.title ?? "").trim();
        if (t) data.title = t;
      }
      if (input.startsAt !== undefined) {
        const d = new Date(input.startsAt);
        if (Number.isNaN(d.getTime())) throw new BadRequestException("invalid start time");
        data.startsAt = d;
      }
      if (typeof input.durationMinutes === "number" && input.durationMinutes > 0) {
        data.durationMinutes = Math.floor(input.durationMinutes);
      }
      if (input.joinUrl !== undefined) {
        const u = normalizeJoinUrl(s.provider as LiveProvider, input.joinUrl);
        if (!u) throw new BadRequestException("Join link must be a valid https URL for the selected provider");
        data.joinUrl = u;
      }
      const row = await tx.lmsLiveSession.update({ where: { id: sessionId }, data });
      await this.log(tx, p, "lms.live.update", sessionId, { status: row.status });
      const count = await tx.lmsLiveAttendance.count({ where: { sessionId } });
      return this.toLiveDto(row, await this.nameOf(tx, row.hostId), count);
    });
  }

  /** The attendance register for a session (host or staff-of-class). */
  async listLiveAttendance(p: Principal, sessionId: string): Promise<LmsLiveAttendanceDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const s = await tx.lmsLiveSession.findFirst({ where: { id: sessionId } });
      if (!s) throw new NotFoundException("Session not found");
      const staff = await this.canAuthor(tx, p, s.classId);
      if (!staff && s.hostId !== p.userId) throw new NotFoundException("Session not found");
      const rows = await tx.lmsLiveAttendance.findMany({ where: { sessionId }, orderBy: { joinedAt: "asc" } });
      const names = await this.nameMap(tx, rows.map((r) => r.studentId));
      return rows.map((r) => ({
        studentId: r.studentId,
        studentName: names.get(r.studentId) ?? "Student",
        joinedAt: r.joinedAt,
      }));
    });
  }

  private toLiveDto(
    row: {
      id: string;
      classId: string;
      title: string;
      provider: string;
      startsAt: Date;
      durationMinutes: number;
      status: string;
      createdAt: Date;
    },
    hostName: string,
    attendeeCount: number,
  ): LmsLiveSessionDto {
    return {
      id: row.id,
      classId: row.classId,
      title: row.title,
      provider: row.provider as LiveProvider,
      startsAt: row.startsAt,
      durationMinutes: row.durationMinutes,
      status: row.status as LiveStatus,
      hostName,
      joinable: isJoinable(row.status, row.startsAt, row.durationMinutes),
      attendeeCount,
      createdAt: row.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Gradebook tagging + "pull LMS scores into the report card"
  // ---------------------------------------------------------------------------
  /** Validate/normalise a gradebook (subject, term) tag. Both-null = untagged.
   *  Only QUIZ/ASSIGNMENT may be tagged; the subject must be offered by the
   *  class and the term must exist. Returns the pair to persist. */
  private async validateGradeTag(
    tx: TenantTx,
    type: LmsContentType,
    classId: string,
    subjectId?: string | null,
    termId?: string | null,
  ): Promise<{ subjectId: string | null; termId: string | null }> {
    const sid = subjectId ?? null;
    const tid = termId ?? null;
    if (!sid && !tid) return { subjectId: null, termId: null };
    if (!sid || !tid) {
      throw new BadRequestException("Both a subject and a term are required to count this toward the report card");
    }
    if (!GRADABLE_TYPES.has(type)) {
      throw new BadRequestException("Only quizzes and assignments can be tagged for the report card");
    }
    const offering = await tx.classSubjectTeacher.findFirst({
      where: { classId, subjectId: sid },
      select: { id: true },
    });
    if (!offering) throw new NotFoundException("That subject is not offered by this class");
    const term = await tx.term.findFirst({ where: { id: tid }, select: { id: true } });
    if (!term) throw new NotFoundException("Term not found");
    return { subjectId: sid, termId: tid };
  }

  /** Max achievable points on a quiz — the possible-score denominator when a
   *  student hasn't attempted (a question-bank draw takes the top-valued Qs). */
  private quizFullTotal(quiz: QuizDefDto): number {
    const pts = quiz.questions.map((q) => (typeof q.points === "number" && q.points > 0 ? q.points : 1));
    const n = quiz.drawCount && quiz.drawCount > 0 && quiz.drawCount < pts.length ? Math.floor(quiz.drawCount) : pts.length;
    return [...pts].sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0);
  }

  /** Aggregate every roster student's score across the class's tagged, PUBLISHED
   *  quizzes + assignments for (subjectId, termId). SIGNALS only — nothing is
   *  written to the report card here (Golden Rule #8). Scope + student set + the
   *  current SubjectResult come from the gradebook roster, so this matches the
   *  grading screen exactly (404 if the caller can't grade the class-subject). */
  async lmsGradebook(p: Principal, classId: string, subjectId: string, termId: string): Promise<LmsGradebookDto> {
    const roster = await this.termResults.getGradingRoster(p, { classId, subjectId, termId });
    const componentMax = gradeComponentMax("assignment");
    const rows = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const contents = (await tx.lmsContent.findMany({
        where: { classId, subjectId, termId, status: "PUBLISHED", type: { in: ["QUIZ", "ASSIGNMENT"] } },
      })) as ContentRow[];
      const contentIds = contents.map((c) => c.id);
      const studentIds = roster.students.map((s) => s.studentId);
      const attempts =
        contentIds.length && studentIds.length
          ? await tx.quizAttempt.findMany({
              where: { contentId: { in: contentIds }, studentId: { in: studentIds } },
              select: { contentId: true, studentId: true, score: true, total: true, attemptNo: true },
              orderBy: { attemptNo: "asc" },
            })
          : [];
      const submissions =
        contentIds.length && studentIds.length
          ? await tx.lmsSubmission.findMany({
              where: { contentId: { in: contentIds }, studentId: { in: studentIds }, status: "GRADED" },
              select: { contentId: true, studentId: true, grade: true },
            })
          : [];

      const quizMeta = new Map<string, { scoring: string; fullTotal: number }>();
      const assignmentMax = new Map<string, number>();
      for (const c of contents) {
        if (c.type === "QUIZ") {
          const quiz = (c.body as unknown as { quiz?: QuizDefDto }).quiz;
          if (quiz) quizMeta.set(c.id, { scoring: quiz.scoring ?? "BEST", fullTotal: this.quizFullTotal(quiz) });
        } else {
          const pts = (c.body as unknown as { points?: number }).points;
          if (typeof pts === "number" && pts > 0) assignmentMax.set(c.id, pts);
        }
      }
      const attemptsByKey = new Map<string, { score: number; total: number; attemptNo: number }[]>();
      for (const a of attempts) {
        const k = `${a.contentId}:${a.studentId}`;
        const arr = attemptsByKey.get(k);
        if (arr) arr.push(a);
        else attemptsByKey.set(k, [a]);
      }
      const gradeByKey = new Map<string, number>();
      for (const s of submissions) gradeByKey.set(`${s.contentId}:${s.studentId}`, s.grade ?? 0);

      return roster.students.map((st): LmsGradeRowDto => {
        let quizEarned = 0;
        let quizPossible = 0;
        let assignmentEarned = 0;
        let assignmentPossible = 0;
        for (const c of contents) {
          const k = `${c.id}:${st.studentId}`;
          if (c.type === "QUIZ") {
            const meta = quizMeta.get(c.id);
            if (!meta) continue;
            const list = attemptsByKey.get(k) ?? [];
            if (list.length === 0) {
              quizPossible += meta.fullTotal; // not attempted → 0 earned, full weight
              continue;
            }
            const chosen =
              meta.scoring === "LATEST" ? list[list.length - 1] : list.reduce((a, b) => (b.score > a.score ? b : a));
            quizEarned += chosen.score;
            quizPossible += chosen.total > 0 ? chosen.total : meta.fullTotal;
          } else {
            const max = assignmentMax.get(c.id);
            if (max === undefined) continue; // ungradable (no points) → excluded
            assignmentPossible += max;
            assignmentEarned += gradeByKey.get(k) ?? 0;
          }
        }
        const earned = quizEarned + assignmentEarned;
        const possible = quizPossible + assignmentPossible;
        const percent = possible > 0 ? Math.round((earned / possible) * 100) : null;
        return {
          studentId: st.studentId,
          studentName: st.studentName,
          quizEarned,
          quizPossible,
          assignmentEarned,
          assignmentPossible,
          earned,
          possible,
          percent,
          suggestedMark: scaleToComponent(percent, componentMax),
          appliedMark: st.result?.assignment ?? null,
          resultStatus: st.result?.status ?? null,
        };
      });
    });
    return {
      classId,
      subjectId,
      subjectName: roster.subjectName,
      termId,
      termName: roster.termName,
      componentMax,
      rows,
    };
  }

  /** Apply each (or selected) student's suggested CA mark into the report card's
   *  assignment component — as DRAFT, MERGED with existing exam/midterm/note
   *  marks, through the guarded grading path. The teacher then PUBLISHES via the
   *  normal maker-checker chain; nothing here is auto-final (Golden Rule #8). */
  async applyLmsGrades(
    p: Principal,
    classId: string,
    subjectId: string,
    termId: string,
    studentIds?: string[],
  ): Promise<LmsGradebookDto> {
    const gb = await this.lmsGradebook(p, classId, subjectId, termId);
    const targetSet = studentIds && studentIds.length ? new Set(studentIds) : null;
    const toApply = gb.rows.filter((r) => r.suggestedMark !== null && (!targetSet || targetSet.has(r.studentId)));
    if (toApply.length === 0) {
      throw new BadRequestException(
        "No LMS scores to apply — students need at least one graded quiz or assignment first.",
      );
    }
    // Each write is individually scope-guarded, merged, and audited by the
    // gradebook service; a loop of small txs keeps each within the interactive cap.
    for (const r of toApply) {
      await this.termResults.applyAssignmentComponent(p, {
        classId,
        subjectId,
        termId,
        studentId: r.studentId,
        assignment: r.suggestedMark as number,
      });
    }
    return this.lmsGradebook(p, classId, subjectId, termId);
  }

  // --- forum (published thread; enrolled students + staff reply) ------------
  async listForum(p: Principal, contentId: string): Promise<ForumPostDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "FORUM_THREAD") throw new BadRequestException("Not a forum thread");
      await this.assertCanRead(tx, p, row);
      const posts = await tx.forumPost.findMany({
        where: { contentId },
        orderBy: { createdAt: "asc" },
      });
      const names = await this.nameMap(tx, posts.map((x: { authorId: string }) => x.authorId));
      return posts.map((x: { id: string; authorId: string; body: string; createdAt: Date }) => ({
        id: x.id,
        authorName: names.get(x.authorId) ?? "User",
        body: x.body,
        createdAt: x.createdAt,
      }));
    });
  }

  async postForum(p: Principal, contentId: string, body: string): Promise<ForumPostDto> {
    const text = (body ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 5000) throw new BadRequestException("Message too long");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      if (row.type !== "FORUM_THREAD") throw new BadRequestException("Not a forum thread");
      if (row.status !== "PUBLISHED") throw new ConflictException("Thread is not published");
      // Staff-of-class or enrolled student may post.
      if (!(await this.canAuthor(tx, p, row.classId))) {
        await this.assertEnrolledOrGuardian(tx, p, row.classId, { studentOnly: true });
      }
      const post = await tx.forumPost.create({
        data: { schoolId: p.schoolId, contentId, authorId: p.userId, body: text },
      });
      await this.log(tx, p, "lms.forum.post", contentId, { postId: post.id });
      const names = await this.nameMap(tx, [p.userId]);
      return { id: post.id, authorName: names.get(p.userId) ?? "User", body: text, createdAt: post.createdAt };
    });
  }

  // =========================================================================
  // internals
  // =========================================================================
  /** Validate the body for its type and return the NORMALISED body to persist
   *  (VIDEO embed URLs are canonicalised + host-allowlisted here). */
  private validateBody(type: LmsContentType, body: LmsContentBody): LmsContentBody {
    if (!body || (body as { kind?: string }).kind !== type) {
      throw new BadRequestException("body.kind must match the content type");
    }
    if (type === "QUIZ") {
      const q = (body as { quiz?: unknown }).quiz;
      if (!isValidQuiz(q)) throw new BadRequestException("invalid quiz definition");
      const quiz = q as QuizDefDto;
      const norm: QuizDefDto = { questions: quiz.questions };
      const isoOrThrow = (v: unknown, label: string) => {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) throw new BadRequestException(`invalid ${label}`);
        return d.toISOString();
      };
      if (quiz.opensAt != null) norm.opensAt = isoOrThrow(quiz.opensAt, "opensAt");
      if (quiz.closesAt != null) norm.closesAt = isoOrThrow(quiz.closesAt, "closesAt");
      if (typeof quiz.maxAttempts === "number" && quiz.maxAttempts > 0) norm.maxAttempts = Math.floor(quiz.maxAttempts);
      if (typeof quiz.drawCount === "number" && quiz.drawCount > 0) norm.drawCount = Math.floor(quiz.drawCount);
      if (typeof quiz.timeLimitMinutes === "number" && quiz.timeLimitMinutes > 0) {
        norm.timeLimitMinutes = Math.floor(quiz.timeLimitMinutes);
      }
      if (quiz.scoring === "LATEST" || quiz.scoring === "BEST") norm.scoring = quiz.scoring;
      return { kind: "QUIZ", quiz: norm };
    }
    if (type === "LESSON") {
      // SECURITY: a lesson is stored as normalised, plain-text blocks — never
      // raw HTML — so it can't carry a script/handler through the approval gate.
      const blocks = normalizeBlocks((body as { blocks?: unknown }).blocks);
      if (blocks.length === 0) throw new BadRequestException("lesson requires at least one content block");
      return { kind: "LESSON", blocks };
    }
    if (type === "FORUM_THREAD" && typeof (body as { intro?: unknown }).intro !== "string") {
      throw new BadRequestException("forum thread requires intro");
    }
    if (type === "VIDEO") {
      const v = body as { provider?: unknown; url?: unknown; description?: unknown };
      if (v.provider !== "YOUTUBE" && v.provider !== "VIMEO") {
        throw new BadRequestException("video provider must be YOUTUBE or VIMEO");
      }
      if (typeof v.url !== "string") throw new BadRequestException("video requires a url");
      // SECURITY: never persist an arbitrary URL — parse to the canonical, host-
      // allowlisted embed form so the client can only ever render a safe iframe.
      const url = this.normalizeEmbedUrl(v.provider, v.url);
      return {
        kind: "VIDEO",
        provider: v.provider,
        url,
        ...(typeof v.description === "string" && v.description.trim()
          ? { description: v.description.trim() }
          : {}),
      };
    }
    if (type === "ASSIGNMENT") {
      const a = body as { instructions?: unknown; dueAt?: unknown; allowLate?: unknown; points?: unknown };
      if (typeof a.instructions !== "string" || !a.instructions.trim()) {
        throw new BadRequestException("assignment requires instructions");
      }
      let dueAt: string | undefined;
      if (a.dueAt != null) {
        const d = new Date(String(a.dueAt));
        if (Number.isNaN(d.getTime())) throw new BadRequestException("invalid due date");
        dueAt = d.toISOString();
      }
      const points = typeof a.points === "number" && a.points > 0 ? Math.floor(a.points) : undefined;
      return {
        kind: "ASSIGNMENT",
        instructions: a.instructions.trim(),
        ...(dueAt ? { dueAt } : {}),
        ...(a.allowLate === true ? { allowLate: true } : {}),
        ...(points ? { points } : {}),
      };
    }
    return body;
  }

  /** Canonicalise + host-allowlist a video embed URL, or 400 if unrecognised. */
  private normalizeEmbedUrl(provider: "YOUTUBE" | "VIMEO", raw: string): string {
    const url = canonicalEmbedUrl(provider, raw);
    if (!url) throw new BadRequestException(`could not read a ${provider === "YOUTUBE" ? "YouTube" : "Vimeo"} video from that link`);
    return url;
  }

  /**
   * Safety net: if a PENDING_APPROVAL item's linked workflow request was decided
   * elsewhere (e.g. the principal approved it in the generic /workflows inbox),
   * reconcile the content status from the request state. Mutates the rows in place
   * and persists the change so students see published content either way.
   */
  private async reconcile(tx: TenantTx, rows: ContentRow[]): Promise<void> {
    const pending = rows.filter((r) => r.status === "PENDING_APPROVAL" && r.approvalRequestId);
    if (pending.length === 0) return;
    const reqs = await tx.workflowRequest.findMany({
      where: { id: { in: pending.map((r) => r.approvalRequestId as string) } },
      select: { id: true, state: true },
    });
    const stateById = new Map(reqs.map((x: { id: string; state: string }) => [x.id, x.state]));
    const MAP: Record<string, LmsContentStatus> = {
      APPROVED: "PUBLISHED",
      REJECTED: "REJECTED",
      REVISION_REQUESTED: "REVISION_REQUESTED",
    };
    for (const r of pending) {
      const next = MAP[stateById.get(r.approvalRequestId as string) ?? ""];
      if (next && next !== r.status) {
        await tx.lmsContent.update({ where: { id: r.id }, data: { status: next } });
        r.status = next;
      }
    }
  }

  private async requireContent(tx: TenantTx, id: string): Promise<ContentRow> {
    const row = (await tx.lmsContent.findFirst({ where: { id } })) as ContentRow | null;
    if (!row) throw new NotFoundException("Content not found");
    return row;
  }

  /** True if the caller may author/manage content for this class (teacher/admin). */
  private async canAuthor(tx: TenantTx, p: Principal, classId: string): Promise<boolean> {
    if (this.isSchoolWide(p)) return true;
    const teaches = await tx.classTeacher.findFirst({
      where: { classId, teacherId: p.userId },
      select: { id: true },
    });
    return !!teaches;
  }

  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (!(await this.canAuthor(tx, p, classId))) throw new NotFoundException("Class not found");
  }

  private async assertEnrolledOrGuardian(
    tx: TenantTx,
    p: Principal,
    classId: string,
    opts: { studentOnly?: boolean } = {},
  ): Promise<void> {
    if (this.isSchoolWide(p)) return;
    const enrolled = await tx.enrollment.findFirst({
      where: { classId, studentId: p.userId },
      select: { id: true },
    });
    if (enrolled) return;
    if (!opts.studentOnly) {
      // A guardian of an enrolled child may read.
      const children = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      if (children.length > 0) {
        const childEnrolled = await tx.enrollment.findFirst({
          where: { classId, studentId: { in: children.map((c: { studentId: string }) => c.studentId) } },
          select: { id: true },
        });
        if (childEnrolled) return;
      }
    }
    throw new NotFoundException("Content not found"); // 404, not 403
  }

  /** Assert the caller may READ this content; returns whether they are staff. */
  private async assertCanRead(tx: TenantTx, p: Principal, row: ContentRow): Promise<boolean> {
    const staff = await this.canAuthor(tx, p, row.classId);
    if (staff) return true;
    // Non-staff: must be enrolled/guardian AND the content must be published.
    await this.assertEnrolledOrGuardian(tx, p, row.classId);
    if (row.status !== "PUBLISHED") throw new NotFoundException("Content not found");
    return false;
  }

  private async nameMap(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
  }

  /** Which of these content ids the student has marked complete. */
  private async completedSet(tx: TenantTx, studentId: string, contentIds: string[]): Promise<Set<string>> {
    if (contentIds.length === 0) return new Set();
    const rows = await tx.lmsProgress.findMany({
      where: { studentId, contentId: { in: contentIds }, status: "COMPLETED" },
      select: { contentId: true },
    });
    return new Set(rows.map((r: { contentId: string }) => r.contentId));
  }

  /** Draw the student's deterministic question subset (question-bank randomisation). */
  private pickForStudent(quiz: QuizDefDto, studentId: string, contentId: string): QuizDefDto {
    if (!quiz.drawCount || quiz.drawCount <= 0) return quiz;
    return { ...quiz, questions: pickQuestions(quiz.questions, `${studentId}:${contentId}`, quiz.drawCount) };
  }

  /** Build the response DTO (author name pre-resolved by the caller). */
  private toDto(
    row: ContentRow,
    staff: boolean,
    authorName: string,
    completed = false,
    viewerId?: string,
  ): LmsContentDto {
    let body = row.body as unknown as LmsContentBody;
    // LESSON: always emit normalised blocks. New lessons store `blocks`; legacy
    // `{html}` lessons are converted to plain-text paragraph blocks on read so
    // the wire (and the client) never receives raw HTML. // SECURITY
    if (row.type === "LESSON") {
      const raw = row.body as unknown as { blocks?: unknown; html?: unknown };
      const blocks = Array.isArray(raw.blocks)
        ? normalizeBlocks(raw.blocks)
        : htmlToBlocks(typeof raw.html === "string" ? raw.html : "");
      body = { kind: "LESSON", blocks };
    }
    // Redact the quiz answer key for non-staff, and draw their question subset.
    if (!staff && row.type === "QUIZ") {
      let quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (quiz) {
        if (viewerId) quiz = this.pickForStudent(quiz, viewerId, row.id);
        body = { kind: "QUIZ", quiz: redactQuiz(quiz) };
      }
    }
    return {
      id: row.id,
      classId: row.classId,
      type: row.type as LmsContentType,
      title: row.title,
      status: row.status as LmsContentStatus,
      authorName,
      body,
      fileName: row.fileUploaded ? row.fileName : null,
      approvalRequestId: row.approvalRequestId,
      moduleId: row.moduleId,
      subjectId: row.subjectId,
      termId: row.termId,
      completed,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** A single author's display name within the current tx. */
  private async nameOf(tx: TenantTx, id: string): Promise<string> {
    return (await this.nameMap(tx, [id])).get(id) ?? "User";
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { actorId: p.userId, action, entity: "lms_content", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
