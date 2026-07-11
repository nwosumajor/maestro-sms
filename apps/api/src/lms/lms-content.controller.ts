// =============================================================================
// LmsContentController — REST surface for learning content (spec/LMS)
// =============================================================================
// Module-gated to the LMS subscription. Per-route permissions: authoring is
// CONTENT_WRITE (teacher of class / school_admin — narrowed in the service);
// approval is CONTENT_APPROVE (principal); quiz-taking is QUIZ_ATTEMPT (student);
// forum replies FORUM_POST. Reads are CONTENT_READ (published-only for students,
// answer keys stripped). The service enforces relationship + approval scoping.
// =============================================================================

import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS, LMS_PERMISSIONS, MODULES } from "@sms/types";
import type {
  ClassProgressDto,
  ForumPostDto,
  LmsAnalyticsDto,
  LmsAwardDto,
  LmsContentBody,
  LmsContentDto,
  LmsGradebookDto,
  LmsLiveAttendanceDto,
  LmsLiveSessionDto,
  LmsModuleDto,
  LmsRevisionDto,
  LmsSubmissionDto,
  XapiStatementDto,
  QuizAttemptGradeDto,
  LmsPresignDto,
  QuizAttemptResultDto,
} from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LmsContentService } from "./lms-content.service";

const bodySchema = z.object({ kind: z.enum(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD", "VIDEO", "ASSIGNMENT"]) }).passthrough();
// A gradebook tag: subject+term (both nullable), sent as `null` to clear.
const gradeTag = {
  subjectId: z.string().uuid().nullable().optional(),
  termId: z.string().uuid().nullable().optional(),
};
const createSchema = z.object({
  type: z.enum(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD", "VIDEO", "ASSIGNMENT"]),
  title: z.string().min(1).max(200),
  body: bodySchema,
  ...gradeTag,
});
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: bodySchema.optional(),
  ...gradeTag,
});
const applyGradesSchema = z.object({
  subjectId: z.string().uuid(),
  termId: z.string().uuid(),
  studentIds: z.array(z.string().uuid()).optional(),
});
const cloneSchema = z.object({ targetClassId: z.string().uuid().optional() });
const awardSchema = z.object({
  studentId: z.string().uuid(),
  badge: z.string().min(1).max(60),
  note: z.string().max(500).optional(),
});
const xapiSchema = z.object({
  verb: z.string().min(1).max(40),
  objectId: z.string().min(1).max(300),
  objectName: z.string().min(1).max(300),
  classId: z.string().uuid().optional(),
  result: z.record(z.unknown()).optional(),
});
const liveCreateSchema = z.object({
  title: z.string().min(1).max(200),
  provider: z.enum(["ZOOM", "MEET", "JITSI", "OTHER"]),
  joinUrl: z.string().min(1).max(2000),
  startsAt: z.string().min(1),
  durationMinutes: z.number().int().positive().max(1440).optional(),
});
const liveUpdateSchema = z.object({
  status: z.enum(["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]).optional(),
  title: z.string().min(1).max(200).optional(),
  joinUrl: z.string().min(1).max(2000).optional(),
  startsAt: z.string().min(1).optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
});
const uploadSchema = z.object({ fileName: z.string().min(1).max(255), contentType: z.string().min(1).max(120) });
const reviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "REQUEST_REVISION"]),
  comments: z.string().max(2000).optional(),
});
const attemptSchema = z.object({ answers: z.record(z.string()) });
const forumSchema = z.object({ body: z.string().min(1).max(5000) });
const submissionSchema = z.object({ text: z.string().min(1).max(50000) });
const gradeSchema = z.object({ grade: z.number().int().min(0), feedback: z.string().max(5000).optional() });
const essayGradeSchema = z.object({ grades: z.record(z.number().int().min(0)) });
const moduleSchema = z.object({ title: z.string().min(1).max(200) });
const assignModuleSchema = z.object({ moduleId: z.string().uuid().nullable() });

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
      subjectId: b.subjectId,
      termId: b.termId,
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
      subjectId: b.subjectId,
      termId: b.termId,
    });
  }

  // --- version history + revert + clone (reuse) — staff-of-class -------------
  @Get("content/:id/revisions")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  revisions(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsRevisionDto[]> {
    return this.content.listRevisions(p, id);
  }

  @Post("content/:id/revert/:revisionId")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  revert(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Param("revisionId") revisionId: string,
  ): Promise<LmsContentDto> {
    return this.content.revertToRevision(p, id, revisionId);
  }

  @Post("content/:id/clone")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  clone(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cloneSchema)) b: z.infer<typeof cloneSchema>,
  ): Promise<LmsContentDto> {
    return this.content.cloneContent(p, id, b.targetClassId);
  }

  // --- xAPI (Tin Can) Learning Record Store ---------------------------------
  @Post("xapi/statements")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  recordStatement(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(xapiSchema)) b: z.infer<typeof xapiSchema>,
  ): Promise<XapiStatementDto> {
    return this.content.recordStatement(p, b);
  }

  @Get("xapi/statements")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listStatements(
    @CurrentPrincipal() p: Principal,
    @Query("classId") classId?: string,
    @Query("studentId") studentId?: string,
  ): Promise<XapiStatementDto[]> {
    return this.content.listStatements(p, { classId, studentId });
  }

  // --- engagement: achievement badges ---------------------------------------
  @Post("classes/:classId/awards")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  awardBadge(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(awardSchema)) b: z.infer<typeof awardSchema>,
  ): Promise<LmsAwardDto> {
    return this.content.awardBadge(p, classId, b);
  }

  @Get("classes/:classId/awards")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listAwards(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<LmsAwardDto[]> {
    return this.content.listAwards(p, classId);
  }

  @Delete("awards/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  revokeAward(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ deleted: boolean }> {
    return this.content.revokeAward(p, id);
  }

  // --- live classroom (scheduled sessions + attendance) ----------------------
  @Post("classes/:classId/live")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  createLive(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(liveCreateSchema)) b: z.infer<typeof liveCreateSchema>,
  ): Promise<LmsLiveSessionDto> {
    return this.content.createLiveSession(p, classId, b);
  }

  @Get("classes/:classId/live")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listLive(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<LmsLiveSessionDto[]> {
    return this.content.listLiveSessions(p, classId);
  }

  /** Reveal the join URL + record attendance (server gates the join window). */
  @Post("live/:id/join")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  joinLive(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ joinUrl: string }> {
    return this.content.joinLiveSession(p, id);
  }

  @Put("live/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  updateLive(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(liveUpdateSchema)) b: z.infer<typeof liveUpdateSchema>,
  ): Promise<LmsLiveSessionDto> {
    return this.content.updateLiveSession(p, id, b);
  }

  @Get("live/:id/attendance")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  liveAttendance(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsLiveAttendanceDto[]> {
    return this.content.listLiveAttendance(p, id);
  }

  // --- pull LMS scores into the report card (grade.write; teacher-of-subject) --
  /** Aggregated LMS scores for a (class, subject, term) — signals for the
   *  teacher; nothing is written until they apply. */
  @Get("classes/:classId/lms-grades")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  lmsGrades(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Query("subjectId") subjectId: string,
    @Query("termId") termId: string,
  ): Promise<LmsGradebookDto> {
    return this.content.lmsGradebook(p, classId, subjectId, termId);
  }

  /** Apply the suggested CA marks into the report card (DRAFT, merged); the
   *  teacher then publishes via the normal maker-checker chain. */
  @Post("classes/:classId/lms-grades/apply")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  applyLmsGrades(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(applyGradesSchema)) b: z.infer<typeof applyGradesSchema>,
  ): Promise<LmsGradebookDto> {
    return this.content.applyLmsGrades(p, classId, b.subjectId, b.termId, b.studentIds);
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

  @Get("content/:id/quiz/me")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  myQuizResult(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
  ): Promise<QuizAttemptResultDto | null> {
    return this.content.myQuizResult(p, id);
  }

  @Get("content/:id/attempts")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  listQuizAttempts(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<QuizAttemptGradeDto[]> {
    return this.content.listQuizAttempts(p, id);
  }

  @Post("attempts/:id/grade-essays")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  gradeQuizEssays(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(essayGradeSchema)) b: z.infer<typeof essayGradeSchema>,
  ): Promise<QuizAttemptGradeDto> {
    return this.content.gradeQuizEssays(p, id, b.grades);
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

  // --- progress / completion ------------------------------------------------
  @Post("content/:id/complete")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  markComplete(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ completed: boolean }> {
    return this.content.markComplete(p, id);
  }

  @Delete("content/:id/complete")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  unmarkComplete(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ completed: boolean }> {
    return this.content.unmarkComplete(p, id);
  }

  @Get("classes/:classId/progress")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  classProgress(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
  ): Promise<ClassProgressDto> {
    return this.content.classProgress(p, classId);
  }

  @Get("classes/:classId/analytics")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  analytics(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<LmsAnalyticsDto> {
    return this.content.classAnalytics(p, classId);
  }

  // --- assignments ----------------------------------------------------------
  @Post("content/:id/submission")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  submitAssignment(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(submissionSchema)) b: z.infer<typeof submissionSchema>,
  ): Promise<LmsSubmissionDto> {
    return this.content.submitAssignment(p, id, b.text);
  }

  @Get("content/:id/submission/me")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  mySubmission(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsSubmissionDto | null> {
    return this.content.mySubmission(p, id);
  }

  @Get("content/:id/submissions")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listSubmissions(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsSubmissionDto[]> {
    return this.content.listSubmissions(p, id);
  }

  @Post("submissions/:id/grade")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  gradeSubmission(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(gradeSchema)) b: z.infer<typeof gradeSchema>,
  ): Promise<LmsSubmissionDto> {
    return this.content.gradeSubmission(p, id, b);
  }

  // --- modules --------------------------------------------------------------
  @Get("classes/:classId/modules")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listModules(@CurrentPrincipal() p: Principal, @Param("classId") classId: string): Promise<LmsModuleDto[]> {
    return this.content.listModules(p, classId);
  }

  @Post("classes/:classId/modules")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  createModule(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Body(new ZodValidationPipe(moduleSchema)) b: z.infer<typeof moduleSchema>,
  ): Promise<LmsModuleDto> {
    return this.content.createModule(p, classId, b.title);
  }

  @Put("modules/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  renameModule(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(moduleSchema)) b: z.infer<typeof moduleSchema>,
  ): Promise<LmsModuleDto> {
    return this.content.renameModule(p, id, b.title);
  }

  @Delete("modules/:id")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  deleteModule(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ deleted: boolean }> {
    return this.content.deleteModule(p, id);
  }

  @Put("content/:id/module")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  assignModule(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(assignModuleSchema)) b: z.infer<typeof assignModuleSchema>,
  ): Promise<LmsContentDto> {
    return this.content.assignContentModule(p, id, b.moduleId);
  }
}
