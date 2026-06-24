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
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import type {
  ForumPostDto,
  LmsContentBody,
  LmsContentDto,
  LmsContentStatus,
  LmsContentType,
  LmsPresignDto,
  QuizAttemptResultDto,
  QuizDefDto,
  WorkflowAction,
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
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import { gradeQuiz, isValidQuiz, redactQuiz } from "./lms-content.util";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);
const CONTENT_TYPES = new Set<LmsContentType>(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD"]);

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
  fileKey: string | null;
  fileName: string | null;
  fileUploaded: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class LmsContentService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
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
    input: { classId: string; type: LmsContentType; title: string; body: LmsContentBody },
  ): Promise<LmsContentDto> {
    if (!CONTENT_TYPES.has(input.type)) throw new BadRequestException("invalid content type");
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");
    this.validateBody(input.type, input.body);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertTeacherOfClass(tx, p, input.classId);
      const row = (await tx.lmsContent.create({
        data: {
          schoolId: p.schoolId,
          classId: input.classId,
          type: input.type,
          title,
          body: input.body as unknown as Prisma.InputJsonValue,
          status: "DRAFT",
          authorId: p.userId,
        },
      })) as ContentRow;
      await this.log(tx, p, "lms.content.create", row.id, { classId: input.classId, type: input.type });
      return this.toDto(row, true, await this.nameOf(tx, row.authorId));
    });
  }

  async updateContent(
    p: Principal,
    contentId: string,
    input: { title?: string; body?: LmsContentBody },
  ): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.assertTeacherOfClass(tx, p, row.classId);
      if (row.status !== "DRAFT" && row.status !== "REVISION_REQUESTED") {
        throw new ConflictException("Only draft / revision-requested content can be edited");
      }
      if (input.body) this.validateBody(row.type as LmsContentType, input.body);
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: {
          ...(input.title ? { title: input.title.trim() } : {}),
          ...(input.body ? { body: input.body as unknown as Prisma.InputJsonValue } : {}),
        },
      })) as ContentRow;
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
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const updated = (await tx.lmsContent.update({
        where: { id: contentId },
        data: { status },
      })) as ContentRow;
      await this.log(tx, p, "lms.content.review", contentId, { action, status });
      return this.toDto(updated, true, await this.nameOf(tx, updated.authorId));
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
      return rows.map((r) => this.toDto(r, staff, names.get(r.authorId) ?? "User"));
    });
  }

  async getContent(p: Principal, contentId: string): Promise<LmsContentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await this.requireContent(tx, contentId);
      await this.reconcile(tx, [row]);
      const staff = await this.assertCanRead(tx, p, row);
      return this.toDto(row, staff, await this.nameOf(tx, row.authorId));
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
      const existing = await tx.quizAttempt.findFirst({
        where: { contentId, studentId: p.userId },
        select: { id: true },
      });
      if (existing) throw new ConflictException("You have already attempted this quiz");
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (!quiz) throw new ConflictException("Quiz has no questions");
      const result = gradeQuiz(quiz, answers ?? {});
      await tx.quizAttempt.create({
        data: {
          schoolId: p.schoolId,
          contentId,
          studentId: p.userId,
          answers: (answers ?? {}) as Prisma.InputJsonValue,
          score: result.score,
          total: result.total,
        },
      });
      await this.log(tx, p, "lms.quiz.attempt", contentId, { score: result.score, total: result.total });
      return result;
    });
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
  private validateBody(type: LmsContentType, body: LmsContentBody): void {
    if (!body || (body as { kind?: string }).kind !== type) {
      throw new BadRequestException("body.kind must match the content type");
    }
    if (type === "QUIZ") {
      const quiz = (body as { quiz?: unknown }).quiz;
      if (!isValidQuiz(quiz)) throw new BadRequestException("invalid quiz definition");
    }
    if (type === "LESSON" && typeof (body as { html?: unknown }).html !== "string") {
      throw new BadRequestException("lesson requires html");
    }
    if (type === "FORUM_THREAD" && typeof (body as { intro?: unknown }).intro !== "string") {
      throw new BadRequestException("forum thread requires intro");
    }
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

  /** Build the response DTO (author name pre-resolved by the caller). */
  private toDto(row: ContentRow, staff: boolean, authorName: string): LmsContentDto {
    let body = row.body as unknown as LmsContentBody;
    // Redact the quiz answer key for non-staff (students/parents).
    if (!staff && row.type === "QUIZ") {
      const quiz = (row.body as unknown as { quiz?: QuizDefDto }).quiz;
      if (quiz) body = { kind: "QUIZ", quiz: redactQuiz(quiz) };
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
