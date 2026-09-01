// =============================================================================
// ScholarshipController — applicant (parent/teacher) + platform owner surfaces
// =============================================================================
// ALWAYS-ON (no @RequireModule): the scholarship is a platform growth lever, open
// to every school regardless of subscription tier. Applicant endpoints are gated
// by `scholarship.apply` + relationship scoping in the service; platform endpoints
// by `scholarship.admin` (super_admin). Money-moving actions (award, program CRUD)
// are step-up gated.
// =============================================================================

import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { DISBURSABLE_AWARD_KINDS, SCHOLARSHIP_APPLICATION_STATUSES, SCHOLARSHIP_PERMISSIONS, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { CbtSittingViewDto, PublishedScholarshipResultsDto, ScholarshipApplicationDto, ScholarshipExamPaperDto, ScholarshipExamQuestionDto } from "@sms/types";
import { narrowStatus, pageNumber } from "../common/status-filter";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ScholarshipService } from "./scholarship.service";
import { ScholarshipAdminService } from "./scholarship-admin.service";

const uuid = z.string().uuid();
const applySchema = z.object({ programId: uuid, studentId: uuid, answers: z.unknown().optional() });
const answersSchema = z.object({ answers: z.unknown().optional() });
const programSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  budgetMinor: z.number().int().min(0),
  awardMinor: z.number().int().positive(),
  // ONLY what the platform can actually pay out. `SUBSCRIPTION_CREDIT` is a
  // stored value nothing disburses, so offering it here lets an operator award
  // a scholarship that moves no money and says nothing.
  awardKind: z.enum(DISBURSABLE_AWARD_KINDS).optional(),
  selectionBasis: z.enum(["MERIT", "NEED", "BOTH"]).optional(),
  eligibility: z.unknown().optional(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  status: z.enum(["DRAFT", "OPEN", "CLOSED", "ARCHIVED"]).optional(),
  award2Minor: z.number().int().positive().nullish(),
  award3Minor: z.number().int().positive().nullish(),
  category: z.enum(["GENERAL_SCIENCE", "ART", "COMMUNITY_DEVELOPMENT", "MATHEMATICS", "SPECIAL"]).optional(),
  examMode: z.enum(["ONLINE_CBT", "GAMES", "PHYSICAL"]).nullish(),
  examAt: z.string().datetime().nullish(),
  examVenue: z.string().max(300).nullish(),
  examDurationMin: z.number().int().min(1).max(600).optional(),
});
const examQuestion = z.object({
  text: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(500)).min(2).max(6),
  answerIndex: z.number().int().min(0).max(5),
  // WHICH PAPER this question belongs to. Omitted means the programme's own
  // category — exactly the single-subject behaviour this generalises, so every
  // question authored before now keeps its paper.
  subject: z.string().min(1).max(80).nullish(),
});
/** When each subject's paper opens. Absent subjects use the programme window. */
const examScheduleSchema = z.record(
  z.string().min(1).max(80),
  z.object({ examAt: z.string().datetime(), durationMin: z.number().int().min(1).max(600).optional() }),
);
const programUpdateSchema = programSchema.partial().extend({
  // Full replace of the CBT question set, OR append one at a time (the console
  // uses append since answers are never read back to the client).
  examQuestions: z.array(examQuestion).max(200).nullish(),
  appendQuestion: examQuestion.optional(),
  examSchedule: examScheduleSchema.nullish(),
});
const stageDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().max(2000).optional() });
const reviewSchema = z.object({ action: z.enum(["REVIEW", "SHORTLIST", "QUALIFY", "REJECT"]), note: z.string().max(2000).optional() });
const decideBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
  // AWARD is absent on purpose: it moves money, grants a school a free tier and
  // consumes one of three positions, so it stays one pupil at a time behind
  // step-up.
  action: z.enum(["REVIEW", "SHORTLIST", "QUALIFY", "REJECT"]),
  note: z.string().max(2000).optional(),
});

const physicalScoresSchema = z.object({
  marks: z
    .array(
      z.object({
        applicationId: z.string().uuid(),
        // A PERCENTAGE, like every other score on this record, so the ranking
        // and the published table compare like with like whatever the mode.
        scorePct: z.number().min(0).max(100),
      }),
    )
    .min(1)
    .max(500),
});

const revokeSchema = z.object({ reason: z.string().min(1).max(2000) });
/** Which paper to open. Omitted is only unambiguous for a single-paper
 *  programme, which is what every one authored before subjects existed is. */
const startExamSchema = z.object({ examId: z.string().uuid().optional() });
/** One multiple-choice answer. Bounded at the boundary like every other body. */
const theoryAnswerSchema = z.object({ questionId: z.string().uuid(), text: z.string().max(20000) });
const integritySchema = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(["FOCUS_LOSS", "PASTE"]),
        awayMs: z.number().int().min(0).max(6 * 60 * 60 * 1000).optional(),
        chars: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .max(200),
});
const answerSchema = z.object({
  questionId: z.string().uuid(),
  choiceIndex: z.number().int().min(0).max(9),
});

const awardSchema = z.object({
  awardMinor: z.number().int().positive().optional(),
  position: z.number().int().min(1).max(3).optional(),
  note: z.string().max(2000).optional(),
});

@Controller("scholarships")
export class ScholarshipController {
  constructor(
    private readonly scholarships: ScholarshipService,
    private readonly admin: ScholarshipAdminService,
  ) {}

  // --- applicant (parent / teacher) ------------------------------------------
  /** Open programs + students I can apply for + my applications + anything
   *  waiting on MY decision. The reviewer gate opens it too: this is where the
   *  pending queue lives, and a reviewer who can decide must be able to see
   *  what is waiting. Every list inside is scoped to the caller regardless. */
  @Get("portal")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY, WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL)
  portal(@CurrentPrincipal() p: Principal) {
    return this.scholarships.getPortal(p);
  }

  @Post("applications")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  apply(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(applySchema)) body: z.infer<typeof applySchema>,
  ) {
    return this.scholarships.apply(p, body);
  }

  @Put("applications/:id")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  updateAnswers(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(answersSchema)) body: z.infer<typeof answersSchema>,
  ) {
    return this.scholarships.updateAnswers(p, id, body.answers ?? null);
  }

  /** Guardian consent — required before submission (Golden Rule #5). */
  @Post("applications/:id/consent")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  consent(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.scholarships.consent(p, id);
  }

  @Post("applications/:id/submit")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  submit(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.scholarships.submit(p, id);
  }

  /** Chain decision (student-initiated requests): the CLASS SUPERVISOR, then the
   *  GUARDIAN (whose approval doubles as consent), then the PRINCIPAL each
   *  approve or reject. One endpoint — the service routes by the application's
   *  current stage and verifies the caller's RELATIONSHIP to the student
   *  (teacher-of-class / linked guardian / holder of workflow.review.principal);
   *  wrong person → 404. Two permissions open it because the applicant side and
   *  the school's final reviewer are different people holding different grants. */
  @Post("applications/:id/decision")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY, WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL)
  decideStage(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(stageDecisionSchema)) body: z.infer<typeof stageDecisionSchema>,
  ) {
    return this.scholarships.decideStage(p, id, body);
  }

  /**
   * The published results, readable by EVERY SCHOOL on the platform.
   *
   * Same audience as the portal — families and the school's reviewer — because
   * publishing is the point: a scholarship is a growth lever, and a result
   * nobody outside the winning school sees does not advertise anything.
   *
   * It carries SCHOOL, POSITION and SCORE. Never a pupil's name.
   */
  @Get("results")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY, WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL)
  publishedResults(): Promise<PublishedScholarshipResultsDto[]> {
    return this.admin.publishedResults();
  }

  // --- sitting the exam (candidates) -----------------------------------------
  //
  // ALWAYS-ON, deliberately. The `cbt` routes are `@RequireModule(MODULES.CBT)`, a
  // PREMIUM module, so a qualified candidate at a STANDARD school was told to
  // sit an exam and met a 404. These routes carry the same audience as the rest
  // of the scholarship — `scholarship.apply`, which students hold — and the
  // SERVICE refuses anything that is not a scholarship exam, so the paid
  // module's gate is untouched rather than made conditional.
  /** The papers this candidate has, and where each stands. A scholarship may be
   *  examined in several subjects, so "the exam" is a list. */
  @Get("exams/:programId/papers")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  examPapers(@CurrentPrincipal() p: Principal, @Param("programId") programId: string): Promise<ScholarshipExamPaperDto[]> {
    return this.scholarships.examPapers(p, programId);
  }

  @Post("exams/:programId/start")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  startExam(
    @CurrentPrincipal() p: Principal,
    @Param("programId") programId: string,
    @Body(new ZodValidationPipe(startExamSchema)) body: z.infer<typeof startExamSchema>,
  ): Promise<CbtSittingViewDto> {
    return this.scholarships.startExam(p, programId, body.examId);
  }

  @Get("sittings/:id")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  examSitting(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.scholarships.getExamSitting(p, id);
  }

  @Post("sittings/:id/answer")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  answerExam(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(answerSchema)) body: z.infer<typeof answerSchema>,
  ): Promise<{ ok: true }> {
    return this.scholarships.answerExam(p, id, body.questionId, body.choiceIndex);
  }

  @Post("sittings/:id/submit")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  submitExam(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<CbtSittingViewDto> {
    return this.scholarships.submitExam(p, id);
  }

  @Post("sittings/:id/answer-theory")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  answerExamTheory(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(theoryAnswerSchema)) body: z.infer<typeof theoryAnswerSchema>,
  ): Promise<{ ok: true }> {
    return this.scholarships.answerExamTheory(p, id, body.questionId, body.text);
  }

  @Post("sittings/:id/integrity")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  examIntegrity(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(integritySchema)) body: z.infer<typeof integritySchema>,
  ) {
    return this.scholarships.recordExamIntegrity(p, id, body.events);
  }

  // --- platform owner (super_admin) ------------------------------------------
  @Get("programs")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  listPrograms() {
    return this.admin.listPrograms();
  }

  /**
   * The exam paper as written, WITH answers — `scholarship.admin` only, so the
   * person who wrote it can read it back and correct it. Deliberately its own
   * route rather than a field on the program: that DTO also serves the
   * candidate portal.
   */
  @Get("programs/:id/questions")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  programQuestions(@Param("id") id: string): Promise<ScholarshipExamQuestionDto[]> {
    return this.admin.listExamQuestions(id);
  }

  @Post("programs")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  createProgram(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(programSchema)) body: z.infer<typeof programSchema>,
  ) {
    return this.admin.createProgram(p, body);
  }

  @Put("programs/:id")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  updateProgram(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(programUpdateSchema)) body: z.infer<typeof programUpdateSchema>,
  ) {
    return this.admin.updateProgram(p, id, body);
  }

  /** School leadership's oversight of their OWN school's applications.
   *
   *  This is what `scholarship.read` is for. Until now it gated nothing: it put
   *  the section in the nav and a "Requests & decisions" tile on the dashboard,
   *  and board / school_admin — who hold READ but not APPLY — arrived at a page
   *  that promised them oversight and fetched nothing. Tenant-scoped by RLS, so
   *  it can only ever return the caller's own school. */
  @Get("school-applications")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.READ)
  listSchoolApplications(@CurrentPrincipal() p: Principal): Promise<ScholarshipApplicationDto[]> {
    return this.scholarships.listForSchool(p);
  }

  /**
   * Move a whole selection through the funnel at once.
   *
   * Declared BEFORE `applications/:id/review` so "decide-bulk" can never be
   * captured as an application id — the same ordering `invoices/issue-bulk`
   * already relies on.
   */
  @Post("applications/decide-bulk")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  decideBulk(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(decideBulkSchema)) body: z.infer<typeof decideBulkSchema>,
  ) {
    return this.admin.decideBulk(p, body.ids, body.action, body.note);
  }

  /** Cross-tenant review queue (non-DRAFT applications across all schools). */
  @Get("applications")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  listApplications(
    @CurrentPrincipal() p: Principal,
    @Query("status") status?: string,
    @Query("programId") programId?: string,
    @Query("page") page?: string,
  ) {
    return this.admin.listApplications(p, {
      status: narrowStatus(status, SCHOLARSHIP_APPLICATION_STATUSES),
      programId,
      // Through the shared narrower, so `?page=abc` is a 400 naming the range
      // rather than `skip: NaN` reaching the database as a 500.
      page: pageNumber(page),
    });
  }

  /** Non-award decisions: REVIEW / SHORTLIST / REJECT. */
  @Post("applications/:id/review")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.admin.decide(p, id, body);
  }

  /**
   * Publish this programme's results to every school. `scholarship.admin`.
   *
   * No step-up: it moves no money and is reversible by the withdraw below —
   * the direction this repo's step-up list already treats as the lighter one.
   */
  @Post("programs/:id/publish-results")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  publish(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.admin.publishResults(p, id);
  }

  @Post("programs/:id/unpublish-results")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  unpublish(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.admin.unpublishResults(p, id);
  }

  /** AWARD — disburses a fees credit; step-up (money moves). */
  @Post("applications/:id/award")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  award(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(awardSchema)) body: z.infer<typeof awardSchema>,
  ) {
    return this.admin.decide(p, id, { action: "AWARD", ...body });
  }

  /**
   * Take an award back — step-up, for the same reason the award needs it: money
   * moves, in the other direction.
   *
   * A REASON IS REQUIRED. This reverses a decision a family was told about and
   * puts a fee back on their account; the note is what the office repeats to
   * them, and an unexplained reversal is the version that generates a complaint.
   */
  @Post("applications/:id/revoke")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
  ) {
    return this.admin.revokeAward(p, id, body.reason);
  }

  /** Announce the qualification exam to every QUALIFIED candidate AND materialize
   *  the real sitting surface (ONLINE_CBT per-school exams / GAMES arena). */
  @Post("programs/:id/announce-exam")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  announceExam(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.admin.announceExam(p, id);
  }

  /** Record a PHYSICAL exam's marks by hand — the only mode with no sitting to
   *  harvest, and the one that could be announced and never scored. */
  @Post("programs/:id/scores")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  // STEP-UP, like AWARD and unlike `collect-results`. Collecting gathers marks
  // candidates actually earned; this CREATES the number the award turns on,
  // with no script behind it, and a school prize of a free session rides on it.
  // The more restrictive option, per Golden Rule #7.
  @RequireStepUp()
  recordScores(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(physicalScoresSchema)) body: z.infer<typeof physicalScoresSchema>,
  ) {
    return this.admin.recordPhysicalScores(p, id, body.marks);
  }

  /** Harvest CBT/arena results back onto the candidates' applications as an
   *  exam-score SIGNAL to inform the award (Golden Rule #8). */
  @Post("programs/:id/collect-results")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  collectResults(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.admin.collectExamResults(p, id);
  }
}
