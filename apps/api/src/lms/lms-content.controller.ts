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
  MyLearningDto,
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
  XapiStatementPageDto,
  QuizAttemptGradeDto,
  LmsLiveSessionPageDto,
  LmsRecordingPresignDto,
  LmsPresignDto,
  QuizAttemptResultDto,
} from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { dateWindow, pageNumber } from "../common/status-filter";
import { isoDay } from "../common/calendar-day";
import { JobRunsService } from "../maintenance/job-runs.service";
import { OPERATOR_PERMISSIONS } from "@sms/types";
import { RecordingRetentionService, type RecordingRetentionResult } from "./recording-retention.service";
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
  // The syllabus TOPIC these notes teach. Validated server-side against the
  // class, since a bare uuid could otherwise point at another class's week.
  syllabusItemId: z.string().uuid().nullish(),
  type: z.enum(["MATERIAL", "LESSON", "QUIZ", "FORUM_THREAD", "VIDEO", "ASSIGNMENT"]),
  title: z.string().min(1).max(200),
  body: bodySchema,
  ...gradeTag,
});
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: bodySchema.optional(),
  // THE LINK HAS TO BE REPAIRABLE. `createSchema` takes a `syllabusItemId` and
  // this did not, so a lesson's link to its scheme-of-work week was one-way:
  // editing the plan sets the FK to NULL (ON DELETE SET NULL) and no route
  // could put it back. A teacher's only recovery was to delete the lesson and
  // make it again, losing its revision history with it.
  //
  // Nullable on purpose — detaching is as legitimate as attaching, and the
  // absent case still means "leave it alone".
  syllabusItemId: z.string().uuid().nullish(),
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
  /** The COURSE. Optional: a form period or assembly has no subject, and
   *  demanding one only makes a teacher pick a wrong answer to get past it. */
  subjectId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  provider: z.enum(["ZOOM", "MEET", "JITSI", "OTHER"]),
  joinUrl: z.string().min(1).max(2000),
  startsAt: z.string().min(1),
  durationMinutes: z.number().int().positive().max(1440).optional(),
});
const liveUpdateSchema = z.object({
  /** `null` clears it — a session mis-filed under a subject must be correctable
   *  back to none, or the only way out is deleting the register with it. */
  subjectId: z.string().uuid().nullable().optional(),
  status: z.enum(["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]).optional(),
  title: z.string().min(1).max(200).optional(),
  joinUrl: z.string().min(1).max(2000).optional(),
  startsAt: z.string().min(1).optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
});
// sizeBytes is REQUIRED: the presigned URL it returns writes straight to our
// bucket, so a cap enforced only in the browser is not a cap at all.
const uploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
});
/** Confirm names the key the presign minted, and the service checks it belongs
 *  to this school and this session rather than trusting it. */
const recordingConfirmSchema = z.object({ key: z.string().min(1).max(500) });
/** Everything the cross-course listing filters by. Dates are days, not
 *  instants — `isoDay` round-trips them, because JS ROLLS an impossible date
 *  rather than refusing it (2026-04-31 parses cleanly as 1 May). */
const liveListSchema = z.object({
  q: z.string().max(200).optional(),
  // `isoDay`, not a shape regex: JavaScript ROLLS `2026-04-31` forward to 1 May
  // rather than refusing it, so only the round trip tells a real day from a
  // plausible-looking one. A filter that silently means a different date is
  // worse than one that refuses.
  from: isoDay.optional(),
  to: isoDay.optional(),
  recorded: z.enum(["1", "true"]).optional(),
  classId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});
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
  constructor(
    private readonly content: LmsContentService,
    private readonly recordingRetention: RecordingRetentionService,
    private readonly jobRuns: JobRunsService,
  ) {}

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
      syllabusItemId: b.syllabusItemId ?? null,
    });
  }

  @Get("classes/:classId/content")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Param("classId") classId: string,
    @Query("type") type?: string,
    @Query("status") status?: string,
  ): Promise<LmsContentDto[]> {
    // Both narrow the QUERY. `status` is ignored for students/parents in the
    // service — it can only ever narrow within PUBLISHED, never widen past it.
    return this.content.listContent(p, classId, { type, status });
  }

  /** A student's learning across every class they are enrolled in, unfinished first.
   *  Self-scoped: there is no id to pass, so it can only ever return your own. */
  @Get("my/learning")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  myLearning(@CurrentPrincipal() p: Principal): Promise<MyLearningDto> {
    return this.content.myLearning(p);
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
      syllabusItemId: b.syllabusItemId,
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

  /**
   * Copy this item onto every other arm of the same stream.
   *
   * Same permission as cloning one, because it does the same thing: a bulk door
   * easier to open than the single one would be a way round the checks rather
   * than a shortcut through them. Authoring rights are re-checked PER ARM.
   */
  @Post("content/:id/copy-to-arms")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  copyToArms(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.content.copyContentToArms(p, id);
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
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
  ): Promise<XapiStatementPageDto> {
    // Through the SHARED narrowers, so a typo is a 400 naming the range rather
    // than a 500 or a silently-ignored filter — the rule the rest of the list
    // endpoints already follow.
    const window = dateWindow(from, to);
    return this.content.listStatements(p, {
      classId,
      studentId,
      from: window.from,
      to: window.to,
      page: pageNumber(page),
    });
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

  /** Every live session this caller can see, across courses — paged, searched
   *  and filtered IN SQL, with the matching total. */
  @Get("live")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  listAllLive(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(liveListSchema)) q: z.infer<typeof liveListSchema>,
  ): Promise<LmsLiveSessionPageDto> {
    return this.content.listAllLiveSessions(p, { ...q, recorded: !!q.recorded });
  }

  // --- recordings: upload (teacher of the class), play (that class's pupils) --
  @Post("live/:id/recording/presign")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  presignRecording(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(uploadSchema)) b: z.infer<typeof uploadSchema>,
  ): Promise<LmsRecordingPresignDto> {
    return this.content.presignRecording(p, id, b);
  }

  @Post("live/:id/recording/confirm")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  confirmRecording(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(recordingConfirmSchema)) b: z.infer<typeof recordingConfirmSchema>,
  ): Promise<LmsLiveSessionDto> {
    return this.content.confirmRecording(p, id, b.key);
  }

  /**
   * A short-lived link that PLAYS the recording and can do nothing else.
   *
   * A POST, not a GET: it mints a credential and writes an audit row, and a GET
   * that does both is a link a browser will prefetch.
   */
  @Post("live/:id/recording/play")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_READ)
  playRecording(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsPresignDto> {
    return this.content.playRecording(p, id);
  }

  @Delete("live/:id/recording")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE)
  deleteRecording(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<LmsLiveSessionDto> {
    return this.content.deleteRecording(p, id);
  }

  /**
   * Run the class-recording purge now.
   *
   * The sweep is nightly; this is for the day somebody asks whether last year's
   * recordings are actually gone and the answer has to be yes rather than
   * "tonight". EITHER door — this school's own teaching staff, or a platform
   * operator running the fleet from the jobs console.
   */
  // `live-recordings/...`, not `live/recordings/...`: this controller is
  // prefixless and `live/:id/...` is already a route, so a literal second
  // segment there is one rename away from being shadowed by the parameter.
  @Post("live-recordings/retention/run")
  @RequirePermission(LMS_PERMISSIONS.CONTENT_WRITE, OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  runRecordingRetention(@CurrentPrincipal() p: Principal): Promise<RecordingRetentionResult> {
    // THE CALLER'S SCHOOL, unless the caller is a platform operator. Running the
    // fleet off a per-school permission is how one teacher's press deletes
    // another school's recordings.
    const fleet = p.permissions.includes(OPERATOR_PERMISSIONS.PLATFORM_OPERATE);
    return this.jobRuns.record("lms.recordingRetention", "MANUAL", () =>
      this.recordingRetention.purgeExpired("MANUAL", fleet ? undefined : p.schoolId),
    );
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

  /**
   * NAMESPACED UNDER `content/`, like every other route in this controller.
   *
   * It was `submissions/:id/grade` — and `GradebookController` declares
   * `submissions/:submissionId/grade` on an equally prefixless `@Controller()`.
   * Two handlers, one URL. Nest maps both and Express answers with the FIRST,
   * which is this one, so the gradebook's own grading endpoint was UNREACHABLE
   * DEAD CODE.
   *
   * Not theoretical: a teacher holding `grade.write` posting the gradebook's own
   * documented body got `400 {"fieldErrors":{"grade":["Required"]}}` — an error
   * about a field they never sent, from a handler they never meant to call —
   * and a principal without `content.write` got a bare 403 for a permission the
   * endpoint they wanted does not require. `grade.status` (DRAFT | PUBLISHED)
   * could not be set through the API at all.
   *
   * This one moves rather than the gradebook's, because this controller already
   * namespaces everything else under `content/` — the collision was this route
   * being the odd one out in its own file — and because it has exactly one
   * caller to update, where the gradebook pair share a path with a GET.
   */
  @Post("content/submissions/:id/grade")
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
