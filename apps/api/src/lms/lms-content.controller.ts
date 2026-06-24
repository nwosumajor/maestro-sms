// =============================================================================
// LmsContentController — REST surface for learning content (spec/LMS)
// =============================================================================
// Module-gated to the LMS subscription. Per-route permissions: authoring is
// CONTENT_WRITE (teacher of class / school_admin — narrowed in the service);
// approval is CONTENT_APPROVE (principal); quiz-taking is QUIZ_ATTEMPT (student);
// forum replies FORUM_POST. Reads are CONTENT_READ (published-only for students,
// answer keys stripped). The service enforces relationship + approval scoping.
// =============================================================================

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { LMS_PERMISSIONS, MODULES } from "@sms/types";
import type {
  ForumPostDto,
  LmsContentBody,
  LmsContentDto,
  LmsPresignDto,
  QuizAttemptResultDto,
} from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsContentService } from "./lms-content.service";

const bodySchema = z.object({ kind: z.enum(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD"]) }).passthrough();
const createSchema = z.object({
  type: z.enum(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD"]),
  title: z.string().min(1).max(200),
  body: bodySchema,
});
const updateSchema = z.object({ title: z.string().min(1).max(200).optional(), body: bodySchema.optional() });
const uploadSchema = z.object({ fileName: z.string().min(1).max(255), contentType: z.string().min(1).max(120) });
const reviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "REQUEST_REVISION"]),
  comments: z.string().max(2000).optional(),
});
const attemptSchema = z.object({ answers: z.record(z.string()) });
const forumSchema = z.object({ body: z.string().min(1).max(5000) });

@RequireModule(MODULES.LMS)
@Controller()
export class LmsContentController {
  constructor(private readonly content: LmsContentService) {}

  @Post("classes/:classId/content")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  create(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(createSchema)) b: z.infer<typeof createSchema>,
  ): Promise<LmsContentDto> {
    return this.content.createContent(p, {
      classId,
      type: b.type,
      title: b.title,
      body: b.body as unknown as LmsContentBody,
    });
  }

  @Get("classes/:classId/content")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  list(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<LmsContentDto[]> {
    return this.content.listContent(p, classId);
  }

  @Get("content/approvals/pending")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_APPROVE)
  pending(@CurrentPrincipal() p: Principal): Promise<LmsContentDto[]> {
    return this.content.listPendingApprovals(p);
  }

  @Get("content/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsContentDto> {
    return this.content.getContent(p, id);
  }

  @Put("content/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateSchema)) b: z.infer<typeof updateSchema>,
  ): Promise<LmsContentDto> {
    return this.content.updateContent(p, id, {
      title: b.title,
      body: b.body as unknown as LmsContentBody | undefined,
    });
  }

  @Post("content/:id/upload")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  upload(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(uploadSchema)) b: z.infer<typeof uploadSchema>,
  ): Promise<LmsPresignDto> {
    return this.content.presignUpload(p, id, b);
  }

  @Post("content/:id/upload/confirm")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  confirm(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsContentDto> {
    return this.content.confirmUpload(p, id);
  }

  @Get("content/:id/download")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  download(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsPresignDto> {
    return this.content.downloadUrl(p, id);
  }

  @Post("content/:id/submit")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  submit(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsContentDto> {
    return this.content.submitForApproval(p, id);
  }

  @Post("content/:id/review")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_APPROVE)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema)) b: z.infer<typeof reviewSchema>,
  ): Promise<LmsContentDto> {
    return this.content.review(p, id, b.action, b.comments);
  }

  @Post("content/:id/quiz/attempt")
  @RequirePermission(LMS_PERMISSIONS.QUIZ_ATTEMPT)
  attempt(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(attemptSchema)) b: z.infer<typeof attemptSchema>,
  ): Promise<QuizAttemptResultDto> {
    return this.content.attemptQuiz(p, id, b.answers);
  }

  @Get("content/:id/forum")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  forum(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ForumPostDto[]> {
    return this.content.listForum(p, id);
  }

  @Post("content/:id/forum")
  @RequirePermission(LMS_PERMISSIONS.FORUM_POST)
  postForum(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(forumSchema)) b: z.infer<typeof forumSchema>,
  ): Promise<ForumPostDto> {
    return this.content.postForum(p, id, b.body);
  }
}
