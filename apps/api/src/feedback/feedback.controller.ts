import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { OPERATOR_PERMISSIONS, FEEDBACK_BULK_MAX, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "@sms/types";
import type { FeedbackStatsDto, FeedbackThreadDto, MyFeedbackDto, PageDto, PlatformFeedbackDto } from "@sms/types";
import { narrowStatus } from "../common/status-filter";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { Principal } from "../integrity/integrity.foundation";
import { FeedbackService } from "./feedback.service";
import { JobRunsService } from "../maintenance/job-runs.service";

const sendSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
const reviewSchema = z.object({ status: z.enum(FEEDBACK_STATUSES), note: z.string().max(2000).nullish() });
const replySchema = z.object({ body: z.string().min(1).max(5000) });
const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(FEEDBACK_BULK_MAX),
  status: z.enum(FEEDBACK_STATUSES),
  note: z.string().max(2000).nullish(),
});

// ALWAYS-ON, no @RequireModule: platform feedback is open to every signed-in user
// regardless of the school's plan.
@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService, private readonly jobRuns: JobRunsService) {}

  /** Send feedback. NO @RequirePermission → any authenticated user (the guard
   *  only enforces a permission when one is declared). A per-IP guard is a coarse
   *  flood backstop; the service also enforces a per-USER rolling-hour cap. */
  @Post("feedback")
  @UseGuards(new RateLimitGuard(20, 60_000))
  send(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.feedback.send(p, body);
  }

  /** The sender's own submissions. Any authenticated user (their own only). */
  @Get("feedback/mine")
  mine(@CurrentPrincipal() p: Principal): Promise<MyFeedbackDto[]> {
    return this.feedback.listMine(p);
  }

  /** The sender reads the conversation on their OWN feedback (404 otherwise). */
  @Get("feedback/:id/thread")
  senderThread(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FeedbackThreadDto> {
    return this.feedback.getSenderThread(p, id);
  }

  /** The sender replies on their OWN feedback. No permission (any user, own only);
   *  per-IP flood guard + a per-USER cap in the service. */
  @Post("feedback/:id/reply")
  @UseGuards(new RateLimitGuard(20, 60_000))
  senderReply(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(replySchema)) body: z.infer<typeof replySchema>) {
    return this.feedback.postSenderMessage(p, id, body.body);
  }

  /** Platform owner: the cross-tenant inbox. */
  @Get("operator/feedback")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("status") status?: string,
    @Query("kind") kind?: string,
  ): Promise<PageDto<PlatformFeedbackDto>> {
    // An unrecognised status was DROPPED, so the operator's feedback queue
    // answered as though unfiltered — every item, under the label they picked.
    return this.feedback.listAll(p, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      status: narrowStatus(status, FEEDBACK_STATUSES),
      kind,
    });
  }

  /** Platform owner: aggregate triage counts for the inbox header. */
  @Get("operator/feedback/stats")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  stats(): Promise<FeedbackStatsDto> {
    return this.feedback.stats();
  }

  /** Platform owner: bulk set a status on many items (up to FEEDBACK_BULK_MAX). */
  @Post("operator/feedback/bulk-review")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  bulkReview(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(bulkSchema)) body: z.infer<typeof bulkSchema>) {
    return this.feedback.bulkReview(p, body.ids, { status: body.status, note: body.note });
  }

  /** Platform owner: run the digest summary now (the scheduled job runs hourly). */
  @Post("operator/feedback/digest/run")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  digest() {
    return this.jobRuns.record("operator.feedbackDigest", "MANUAL", () =>
      this.feedback.digestSweep(),
    );
  }

  /** Platform owner: read the full conversation (cross-tenant). */
  @Get("operator/feedback/:id/thread")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  platformThread(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<FeedbackThreadDto> {
    return this.feedback.getPlatformThread(p, id);
  }

  /** Platform owner: reply to the sender (notifies them directly). */
  @Post("operator/feedback/:id/reply")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  platformReply(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(replySchema)) body: z.infer<typeof replySchema>) {
    return this.feedback.postPlatformMessage(p, id, body.body);
  }

  @Post("operator/feedback/:id/review")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_FEEDBACK_REVIEW)
  review(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    return this.feedback.review(p, id, body);
  }
}
