import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Headers,
  Logger,
} from "@nestjs/common";
import type {
  NotificationInboxDto,
  DeliveryProblemsDto,
  NotificationPreferenceDto,
} from "@sms/types";
import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PERMISSIONS,
  NOTIFICATION_TYPES,
  MUTABLE_NOTIFICATION_TYPES,
  FEES_PERMISSIONS,
  BILLING_PERMISSIONS,
} from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { NotificationService } from "./notification.service";
import { NotificationRecoveryService, type NotificationRecoveryResult } from "./notification-recovery.service";
import { JobRunsService } from "../maintenance/job-runs.service";
import { MessageCreditReconciliationService } from "./message-credit-reconciliation.service";
import { Public } from "../auth/public.decorator";
import { MessageCreditsService } from "./message-credits.service";
import { verifyTwilioSignature } from "./twilio-channel.provider";

// Loose E.164: 8–15 digits with an optional +. Empty string clears the number.
const languageSchema = z.object({
  locale: z.string().max(8).nullable().optional(),
});
const phoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(
      /^(\+?\d{8,15})?$/,
      "Enter the number in international format, e.g. +2348012345678",
    ),
});

const preferencesSchema = z.object({
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  // Only a type the school has decided is optional. An unconstrained string
  // array made the curated list advisory — a request naming any non-essential
  // type would mute it, including ones no screen ever offered.
  mutedTypes: z
    .array(z.enum(MUTABLE_NOTIFICATION_TYPES.map((m) => m.type) as [string, ...string[]]))
    .max(MUTABLE_NOTIFICATION_TYPES.length),
});

const sendSchema = z.object({
  recipientId: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES).default("ANNOUNCEMENT"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  data: z.record(z.unknown()).optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).optional(),
});

@Controller("notifications")
export class NotificationController {
  private readonly logger = new Logger("Notifications");
  constructor(
    private readonly credits: MessageCreditsService,
    private readonly creditReconcile: MessageCreditReconciliationService,
    private readonly notifications: NotificationService,
    private readonly recovery: NotificationRecoveryService,
    private readonly jobRuns: JobRunsService,
  ) {}

  /**
   * What did NOT reach a family, and why.
   *
   * Every external failure has always been recorded and nothing ever read it, so
   * a school could not learn that a fee notice bounced or a parent's number was
   * rejected. Gated on `notification.send` — whoever may send is who needs to
   * know what did not arrive.
   */
  @Get("deliveries/problems")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND)
  deliveryProblems(
    @CurrentPrincipal() p: Principal,
    @Query("days") days?: string,
    @Query("limit") limit?: string,
  ): Promise<DeliveryProblemsDto> {
    return this.notifications.deliveryProblems(p, {
      days: days ? Number(days) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Run the stranded-delivery sweep now (it also runs hourly).
   *
   * Recorded as a MANUAL run like every other hand-runnable job, so the
   * maintenance console shows it alongside the scheduled ones — a sweep whose
   * manual runs are invisible is exactly the thing this whole area was about.
   */
  @Post("deliveries/recovery/run")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND)
  runRecovery(): Promise<NotificationRecoveryResult> {
    return this.jobRuns.record("notifications.deliveryRecovery", "MANUAL", () =>
      this.recovery.recoverStranded("MANUAL"),
    );
  }

  /**
   * The caller's own inbox (self-scoped), one page at a time.
   *
   * `?unread=1` unread only, `?type=` one kind, `?q=` a search over title and
   * body, `?page=` anything older than the first page. The filters are applied
   * in SQL, so they search the whole inbox rather than the page it happened to
   * return — the distinction that made the old "most recent hundred" a record
   * nobody could look anything up in.
   */
  @Get()
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("unread") unread?: string,
    @Query("limit") limit?: string,
    @Query("page") page?: string,
    @Query("type") type?: string,
    @Query("q") q?: string,
  ): Promise<NotificationInboxDto> {
    const n = limit ? Number(limit) : undefined;
    const pg = page ? Number(page) : undefined;
    return this.notifications.listMine(p, {
      unreadOnly: unread === "1" || unread === "true",
      limit: Number.isFinite(n) ? n : undefined,
      page: Number.isFinite(pg) ? pg : undefined,
      type: type?.trim() || undefined,
      q: q?.trim() || undefined,
    });
  }

  /** Mark ALL of the caller's own notifications read — one statement, not one
   *  request per row. */
  @Post("read-all")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  markAllRead(@CurrentPrincipal() p: Principal) {
    return this.notifications.markAllRead(p);
  }

  /** Mark one of the caller's own notifications read. */
  @Post(":id/read")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  markRead(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.notifications.markRead(p, id);
  }

  /** The caller's own mobile number (SMS/WhatsApp delivery target). */
  @Get("me/phone")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  myPhone(@CurrentPrincipal() p: Principal) {
    return this.notifications.getMyPhone(p);
  }

  /** Set/clear the caller's own mobile number. Self-scoped; audited. */
  @Put("me/phone")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  setMyPhone(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(phoneSchema)) body: z.infer<typeof phoneSchema>,
  ) {
    return this.notifications.setMyPhone(p, body.phone || null);
  }

  /** The language the caller is written to in. Null = follow the school. */
  @Get("me/language")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  myLanguage(@CurrentPrincipal() p: Principal) {
    return this.notifications.getMyLanguage(p);
  }

  /** Set or clear it. Self-scoped; audited. */
  @Put("me/language")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  setMyLanguage(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(languageSchema))
    body: z.infer<typeof languageSchema>,
  ) {
    return this.notifications.setMyLanguage(p, body.locale || null);
  }

  /** The caller's own external-channel delivery preferences (self-scoped). */
  @Get("me/preferences")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  myPreferences(
    @CurrentPrincipal() p: Principal,
  ): Promise<NotificationPreferenceDto> {
    return this.notifications.getMyPreferences(p);
  }

  @Put("me/preferences")
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_READ)
  setMyPreferences(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(preferencesSchema))
    body: z.infer<typeof preferencesSchema>,
  ): Promise<NotificationPreferenceDto> {
    return this.notifications.setMyPreferences(p, body);
  }

  /** Staff send to a user (relationship-scoped in the service). */
  @Post()
  @RequirePermission(NOTIFICATION_PERMISSIONS.NOTIFICATION_SEND)
  send(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(sendSchema)) body: z.infer<typeof sendSchema>,
  ) {
    return this.notifications.send(p, body);
  }

  /** Settle a credit bundle the school has just returned from paying for.
   *  billing.read: the person coming back from the gateway is whoever started
   *  the checkout, and refusing to credit a bundle already paid for because of
   *  a permission check would be the wrong way round. */
  @Post("credits/verify")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  verifyCredits(
    @CurrentPrincipal() p: Principal,
    @Body(
      new ZodValidationPipe(
        z.object({ reference: z.string().min(4).max(128) }),
      ),
    )
    body: { reference: string },
  ) {
    return this.credits.verifyPurchase(p, body.reference);
  }

  /** The school's OWN credit ledger — where its credits went. billing.read,
   *  the same permission that shows the balance beside it. */
  @Get("credits/ledger")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  creditLedger(
    @CurrentPrincipal() p: Principal,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.credits.ledger(
      p,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 25,
    );
  }

  /**
   * Twilio delivery-status callback. PUBLIC — Twilio carries no session.
   *
   * A send is charged when the provider ACCEPTS it, which is not the same as
   * delivering it: a carrier reject or an unreachable handset comes back
   * minutes later, and until now the school stayed charged for a message that
   * never arrived. On a terminal failure the credit is refunded as a new
   * ledger entry, idempotent on the provider's own id.
   *
   * ALWAYS answers 2xx — a non-2xx makes Twilio retry the callback for hours,
   * the same rule the mobile-money rails follow.
   */
  @Public()
  @Post("credits/delivery-status")
  async deliveryStatus(
    @Body() body: Record<string, string>,
    @Headers("x-twilio-signature") signature?: string,
  ): Promise<{ ok: true }> {
    // VERIFIED, like every other webhook here. This is a PUBLIC route that
    // hands credits back: unverified, anyone who learned a message SID could
    // refund a school's credits. Still answers 2xx on a bad signature — a
    // non-2xx makes Twilio retry for hours, and a forged callback should be
    // dropped quietly rather than invited back.
    const url = `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/api/webhooks/twilio`;
    if (!verifyTwilioSignature(url, body, signature ?? null))
      return { ok: true };
    const sid = body.MessageSid ?? body.SmsSid;
    const status = (body.MessageStatus ?? body.SmsStatus ?? "").toLowerCase();
    // Only TERMINAL failures refund. "sent"/"queued"/"delivered" are not
    // failures, and refunding a message still in flight would hand back a
    // credit that is about to be spent again.
    if (sid && ["failed", "undelivered"].includes(status)) {
      await this.credits.refundFailedSend(sid, status).catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * Run the credit reconciliation now. Same permission as the card-rail sweep
   * (`fee.reconcile.run`, super_admin-only): it is a cross-tenant operation
   * that touches money, so it is not a school-level button.
   */
  @Post("credits/reconcile/run")
  @RequirePermission(FEES_PERMISSIONS.FEE_RECONCILE_RUN)
  reconcileCredits() {
    return this.creditReconcile.sweep("MANUAL");
  }
}
