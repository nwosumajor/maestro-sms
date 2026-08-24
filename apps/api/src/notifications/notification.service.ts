// =============================================================================
// NotificationService — in-app inbox + async multi-channel delivery
// =============================================================================
// The Notification row IS the in-app inbox item; external channels (email/SMS/
// push) are recorded as NotificationDelivery rows and delivered ASYNC by the
// BullMQ worker (runDeliveries). Everything runs in a tenant transaction
// (RLS-enforced).
//   - listMine / markRead are SELF-scoped: a user only ever touches their own
//     inbox (recipientId = caller). 404 on someone else's notification.
//   - send() is staff-only (gated by notification.send) AND relationship-scoped
//     here: a teacher may only notify their own students / those students'
//     guardians; school staff anyone in the tenant.
//   - enqueue() is the INTERNAL producer API (e.g. Attendance) — trusted, not
//     permission-gated; the caller's Principal supplies tenant + actor.
// =============================================================================

import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { MessageCreditsService } from "./message-credits.service";
import { Prisma } from "@sms/db";
import type { Queue } from "bullmq";
import type { NotificationChannelValue, NotificationTypeValue, NotificationPreferenceDto, MessageLanguage, DeliveryProblemsDto } from "@sms/types";
import { MESSAGE_LANGUAGES, messageLanguage, renderNotification } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import { SchoolStatusService } from "../foundation/school-status.service";
import { allowedChannels, deliverableEmail } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import {
  DELIVER_NOTIFICATION_JOB,
  NOTIFICATION_CHANNEL_PROVIDER,
  NOTIFICATION_QUEUE,
  type DeliverNotificationJob,
  type NotificationChannelProvider,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_COUNT_CAP,
} from "./notification.constants";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal"]);

export interface NotificationInput {
  recipientId: string;
  type: NotificationTypeValue | string;
  /** English fallback, and what is stored when no `key` is given. */
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** External channels to ALSO deliver. In-app is always created. */
  channels?: NotificationChannelValue[];
  /**
   * A `NOTIFICATION_MESSAGES` key, for producers that want the text written in
   * the RECIPIENT's language.
   *
   * A composed `title`/`body` has already picked a language, and the producer
   * does not know who is about to read it — `enqueueMany` sends one notification
   * to a class of guardians who need not share a language. Passing a key defers
   * that choice to `persist`, which runs once per recipient.
   *
   * Optional on purpose: the ~95 existing producers keep working in English and
   * migrate one at a time. An untranslated notice is a far smaller problem than
   * a rewrite of every call site at once.
   */
  key?: string;
  params?: Record<string, string | number>;
}

@Injectable()
export class NotificationService {
  /** A send that happened but could not be written down has to be visible. */
  private readonly logger = new Logger("Notification");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @Optional()
    @Inject(NOTIFICATION_CHANNEL_PROVIDER)
    private readonly channels?: NotificationChannelProvider,
    // Optional so existing unit tests / minimal wirings keep working; when
    // absent, SMS/WhatsApp deliveries are unmetered (dev stub behaviour).
    @Optional() private readonly credits?: MessageCreditsService,
    // Optional for the same reason as `credits`: unit tests wire the service
    // directly. Absent, a recipient with no locale of their own falls back to
    // the platform default rather than to their school's.
    @Optional() private readonly regions?: SchoolRegionService,
    // Optional for the same reason again. Absent, nothing is suppressed.
    @Optional() private readonly schoolStatus?: SchoolStatusService,
  ) {}

  private ctx(p: TenantContext): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  // --- producer API (internal, trusted) -------------------------------------
  /** Create + queue a notification. Used by system producers (e.g. Attendance). */
  async enqueue(actor: TenantContext, input: NotificationInput) {
    const { notification, deliveries } = await this.db.runAsTenant(this.ctx(actor), (tx) =>
      this.persist(tx, actor, input),
    );
    if (deliveries > 0) await this.queueDelivery(actor, notification.id);
    return notification;
  }

  /**
   * Enqueue the SAME notification for many recipients, in ONE tenant transaction.
   *
   * The alternative — awaiting `enqueue` per recipient — opens a transaction and a
   * queue round-trip each time. That is fine for the two or three guardians most
   * producers notify, but a whole class plus their guardians is ~100, and the one
   * place that happens is releasing an exam: the single most latency-sensitive
   * click in the product, made by a principal with a hall full of students waiting.
   *
   * Per-recipient failures are ISOLATED rather than fatal. A release that already
   * committed must not be reported as failed because one recipient's row could not
   * be written, so this returns the count and lets the caller carry on.
   */
  /**
   * Tell the people who can act on something that it is waiting for them.
   *
   * Written because it kept being needed and kept being skipped. A request that
   * needs a second person — a salary change, an invoice waiver, an erasure
   * request under a statutory deadline, a boarder asking to leave site — was
   * created and announced to nobody, and every one of those paths had its own
   * reason for it: the notification was somebody else's job, or the screen would
   * show it, or it simply was not thought about. Five separate services, the
   * same gap. One helper is harder to forget than five call sites.
   *
   * Recipients are resolved from the PERMISSION, not from a role list. A school
   * that grants fee.approve to a bursar rather than the principal still gets
   * told, and the notice cannot drift from the guard on the endpoint that
   * approves — they name the same string.
   *
   * // SECURITY: `exclude` is not optional in practice. Every one of these is a
   * // maker-checker control, so the person who raised the request must never be
   * // invited to approve it — the endpoint refuses them, and a notice saying
   * // otherwise sends somebody to a button that does not work.
   *
   * Best-effort by contract: returns the number told and raises nothing. The
   * thing being announced has already happened, and telling somebody about it
   * must never be able to undo it.
   */
  async notifyPermissionHolders(
    actor: TenantContext,
    permission: string,
    input: Omit<NotificationInput, "recipientId">,
    opts: { exclude?: string[] } = {},
  ): Promise<number> {
    try {
      const rows = await this.db.runAsTenantReadOnly(this.ctx(actor), async (tx) =>
        // ONE query. Tenant-scoped by RLS, so these are the school's own staff.
        (await tx.userRole.findMany({
          where: { role: { permissions: { some: { permission: { key: permission } } } } },
          select: { userId: true },
          distinct: ["userId"],
        })) as Array<{ userId: string }>,
      );
      const skip = new Set(opts.exclude ?? []);
      const to = [...new Set(rows.map((r) => r.userId))].filter((id) => !skip.has(id));
      if (to.length === 0) return 0;
      const { created } = await this.enqueueMany(actor, to, input);
      return created;
    } catch (e) {
      this.logger.warn(`notifying holders of ${permission} failed: ${(e as Error).message}`);
      return 0;
    }
  }

  async enqueueMany(
    actor: TenantContext,
    recipientIds: string[],
    input: Omit<NotificationInput, "recipientId">,
  ): Promise<{ created: number; failed: number }> {
    const uniq = [...new Set(recipientIds)].filter(Boolean);
    if (uniq.length === 0) return { created: 0, failed: 0 };
    const results = await this.db.runAsTenant(this.ctx(actor), async (tx) => {
      const out: Array<{ id: string; deliveries: number } | null> = [];
      for (const recipientId of uniq) {
        try {
          const { notification, deliveries } = await this.persist(tx, actor, { ...input, recipientId });
          out.push({ id: notification.id, deliveries });
        } catch {
          out.push(null); // one bad recipient must not sink the batch
        }
      }
      return out;
    });
    // Queue OUTSIDE the transaction: a Redis hiccup must not roll back the inbox
    // rows, which are the durable record. Delivery is the best-effort part.
    let created = 0;
    for (const r of results) {
      if (!r) continue;
      created += 1;
      if (r.deliveries > 0) {
        try {
          await this.queueDelivery(actor, r.id);
        } catch {
          /* non-fatal: the in-app inbox row exists regardless */
        }
      }
    }
    return { created, failed: results.length - created };
  }

  // --- staff send (permission-gated by controller; scoped here) -------------
  async send(p: Principal, input: NotificationInput) {
    const { notification, deliveries } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanSendTo(tx, p, input.recipientId);
      return this.persist(tx, p, input);
    });
    if (deliveries > 0) await this.queueDelivery(p, notification.id);
    return notification;
  }

  // --- recipient inbox (self-scoped) ----------------------------------------
  /**
   * One page of the caller's own inbox — filtered, searchable, counted.
   *
   * It used to be "the most recent hundred", with nothing said about the rest.
   * That is right for a queue and wrong for a record, and this inbox is both.
   * The platform owner's is the clearest case: operator alerts, dunning digests,
   * dispute warnings and onboarding requests all land here, and it is where "did
   * anyone get told about that" is answered months later. With 500,000 rows the
   * page showed a hundred, offered no filter, and had no way to reach the other
   * 499,900.
   *
   * FILTERED IN SQL, never in memory: narrowing the most-recent hundred can only
   * ever search the most-recent hundred, so a type filter would have quietly
   * meant "of the last hundred" — the same trap the approvals register had.
   *
   * The `q` search is an ILIKE and CANNOT be index-accelerated here: `texticlike`
   * is not leakproof, so under RLS Postgres refuses to evaluate it before the
   * row-security qual and no trigram index is reachable (three that were added on
   * that assumption are dropped in 20261228000000). What bounds it instead is the
   * (schoolId, recipientId, createdAt) index: the scan is over the CALLER'S OWN
   * inbox, not the table — 0.9 ms for an ordinary one.
   */
  async listMine(
    p: Principal,
    opts?: { unreadOnly?: boolean; limit?: number; page?: number; type?: string; q?: string },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const needle = opts?.q?.trim();
      const where: Record<string, unknown> = {
        recipientId: p.userId,
        ...(opts?.unreadOnly ? { readAt: null } : {}),
        ...(opts?.type ? { type: opts.type } : {}),
        ...(needle
          ? {
              OR: [
                { title: { contains: needle, mode: "insensitive" as const } },
                { body: { contains: needle, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      // The dashboard shows six; the inbox page shows a page of fifty. Fetching a
      // hundred rows to render six is the kind of waste that only shows up as a
      // slow home page nobody can attribute to anything.
      const take = Math.min(Math.max(opts?.limit ?? NOTIFICATION_PAGE_SIZE, 1), 100);
      const page = Math.max(1, Math.floor(opts?.page ?? 1));
      // COUNTS ARE CAPPED, THE PAGE IS NOT.
      //
      // A plain `count` walks every row the recipient has ever received: 27 ms
      // for the total and 42 ms for a filtered one on 500,000 rows, on every
      // page load, growing every year the account exists. Bounding the count at
      // NOTIFICATION_COUNT_CAP makes that a fixed cost and "1,000+" is as useful
      // to read as "47,213". Paging is not bounded by it — `hasMore` comes from
      // fetching one row past the page, so the owner can still walk back to
      // anything in the inbox.
      const cappedCount = async (w: Record<string, unknown>) =>
        (await tx.notification.findMany({ where: w, select: { id: true }, take: NOTIFICATION_COUNT_CAP })).length;
      const [rows, unread, total] = await Promise.all([
        tx.notification.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * take,
          // One past the page: the only honest way to say "there is more" without
          // paying for a full count.
          take: take + 1,
        }),
        // The badge always counts ALL unread, never "unread on this page" — it is
        // the number that tells somebody to come back to this screen.
        cappedCount({ recipientId: p.userId, readAt: null }),
        cappedCount(where),
      ]);
      const items = rows.slice(0, take);
      return {
        items,
        unread,
        unreadIsCapped: unread >= NOTIFICATION_COUNT_CAP,
        total,
        totalIsCapped: total >= NOTIFICATION_COUNT_CAP,
        page,
        pageSize: take,
        hasMore: rows.length > take,
      };
    });
  }

  /**
   * Mark every one of the caller's unread notifications read, in ONE statement.
   *
   * The web used to loop `POST :id/read` — one sequential round trip per
   * notification, so a full inbox was dozens of requests taking as many
   * latencies, and a failure halfway left some read and some not with nothing
   * said. One UPDATE is both faster and atomic: it either all happened or none
   * of it did.
   *
   * Scoped to `recipientId = p.userId`: "all" means all of MINE. There is no
   * form of this that can touch another person's inbox.
   */
  async markAllRead(p: Principal): Promise<{ read: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.notification.updateMany({
        where: { recipientId: p.userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { read: res.count };
    });
  }

  async markRead(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // SECURITY: scope to the caller's own row — you can only read-receipt your
      // own notification. 0 rows -> 404, never reveal another user's.
      const res = await tx.notification.updateMany({
        where: { id, recipientId: p.userId, readAt: null },
        data: { readAt: new Date() },
      });
      if (res.count === 0) {
        const exists = await tx.notification.findFirst({
          where: { id, recipientId: p.userId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException("Notification not found");
      }
      return { id, read: true };
    });
  }

  // --- self-service delivery preferences --------------------------------------
  /** Read a recipient's preference row inside an existing tenant tx (delivery
   *  producer). Null when the user has never set one (= deliver all). */
  private async recipientPreference(tx: TenantTx, userId: string): Promise<NotificationPreferenceDto | null> {
    const row = await tx.notificationPreference.findFirst({
      where: { userId },
      select: { emailEnabled: true, smsEnabled: true, whatsappEnabled: true, mutedTypes: true },
    });
    return row
      ? { emailEnabled: row.emailEnabled, smsEnabled: row.smsEnabled, whatsappEnabled: row.whatsappEnabled, mutedTypes: row.mutedTypes }
      : null;
  }

  async getMyPreferences(p: Principal): Promise<NotificationPreferenceDto> {
    const pref = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.recipientPreference(tx, p.userId));
    return pref ?? { emailEnabled: true, smsEnabled: true, whatsappEnabled: true, mutedTypes: [] };
  }

  async setMyPreferences(p: Principal, input: NotificationPreferenceDto): Promise<NotificationPreferenceDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const mutedTypes = [...new Set(input.mutedTypes)];
      await tx.notificationPreference.upsert({
        where: { userId: p.userId },
        create: { schoolId: p.schoolId, userId: p.userId, ...input, mutedTypes },
        update: { emailEnabled: input.emailEnabled, smsEnabled: input.smsEnabled, whatsappEnabled: input.whatsappEnabled, mutedTypes },
      });
      await this.audit.record(
        { actorId: p.userId, action: "notification.preferences.set", entity: "user", entityId: p.userId, schoolId: p.schoolId, metadata: { mutedCount: mutedTypes.length } },
        tx,
      );
      return { ...input, mutedTypes };
    });
  }

  // --- self-service language ---------------------------------------------------
  /**
   * The caller's own writing language.
   *
   * `null` means "follow the school", which is the state every existing user is
   * in — so the effective value is returned alongside, or the /account screen
   * could only show a blank where a parent expects to see what they will be
   * written in.
   */
  async getMyLanguage(p: Principal): Promise<{ locale: string | null; effective: string }> {
    const row = (await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      tx.user.findFirst({ where: { id: p.userId }, select: { locale: true } }),
    )) as { locale: string | null } | null;
    if (row?.locale) return { locale: row.locale, effective: messageLanguage(row.locale) };
    const region = await this.regions?.forSchool(p.schoolId);
    return { locale: null, effective: messageLanguage(region?.locale) };
  }

  /** Set or clear it. Clearing (null) hands the choice back to the school. */
  async setMyLanguage(p: Principal, locale: string | null): Promise<{ locale: string | null; effective: string }> {
    // Refused rather than silently stored: an unsupported value would resolve to
    // English at send time and the user would never learn why their choice did
    // nothing. Egypt's Arabic is the live example — see MESSAGE_LANGUAGES.
    if (locale && !(MESSAGE_LANGUAGES as readonly string[]).includes(locale)) {
      throw new BadRequestException(
        `Language must be one of ${MESSAGE_LANGUAGES.join(", ")}. Clear it to follow the school's own language.`,
      );
    }
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await tx.user.update({ where: { id: p.userId }, data: { locale } });
      await this.audit.record(
        { actorId: p.userId, action: "notification.language.set", entity: "user", entityId: p.userId, schoolId: p.schoolId, metadata: { locale } },
        tx,
      );
    });
    return this.getMyLanguage(p);
  }

  // --- self-service delivery target (mobile number) ---------------------------
  async getMyPhone(p: Principal): Promise<{ phone: string | null }> {
    const row = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.user.findFirst({ where: { id: p.userId }, select: { phone: true } }),
    );
    return { phone: row?.phone ?? null };
  }

  async setMyPhone(p: Principal, phone: string | null): Promise<{ phone: string | null }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await tx.user.update({ where: { id: p.userId }, data: { phone } });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "notification.phone.set",
          entity: "user",
          entityId: p.userId,
          schoolId: p.schoolId,
          // Never log the full number — last 4 digits identify the change.
          metadata: { last4: phone ? phone.slice(-4) : null, cleared: !phone },
        },
        tx,
      );
      return { phone };
    });
  }

  // --- worker: perform external deliveries -----------------------------------
  /**
   * Deliver a notification's pending channels.
   *
   * THE GATEWAY CALL IS NOT INSIDE A TRANSACTION, and that is the whole shape of
   * this method. It used to be: the loop ran inside `runAsTenant`, so a Twilio
   * round trip was held open inside a Prisma interactive transaction whose
   * default cap is five seconds — and the provider's `fetch` had no timeout at
   * all, so a stalled connection could sit there indefinitely.
   *
   * When that cap fires the transaction ROLLS BACK. The SMS has already gone:
   * Twilio has taken it, the parent has read it, the platform has been billed.
   * What is undone is our side of it — the SENT row and the credit debit — after
   * which BullMQ retries the job and sends the message AGAIN. Duplicate messages
   * to families, double gateway spend, and a school under-charged for both.
   *
   * So: read in a transaction, deliver outside one, record in a transaction.
   */
  async runDeliveries(job: DeliverNotificationJob): Promise<{ sent: number; failed: number }> {
    const ctx = { schoolId: job.schoolId, userId: job.userId };

    // --- 1. Decide what to attempt. No external calls in here. ---------------
    const plan = await this.db.runAsTenant(ctx, async (tx) => {
      const notification = await tx.notification.findFirst({ where: { id: job.notificationId } });
      if (!notification) return null;
      const recipient = await tx.user.findFirst({
        where: { id: notification.recipientId },
        select: { email: true, contactEmail: true, phone: true },
      });
      const pending = await tx.notificationDelivery.findMany({
        where: { notificationId: job.notificationId, status: "PENDING" },
      });

      // The metered budget is taken ONCE and shared out below. Checking per
      // delivery used to work because each debit landed in the same transaction
      // the next check read; now that the debits happen later, an allowance is
      // what keeps two metered channels from both spending the school's last
      // credit.
      //
      // Read LAZILY: an email-only notification is the common case and has no
      // business asking the ledger anything.
      let allowance: number | null = null;
      const remaining = async (): Promise<number> => {
        if (allowance === null) {
          allowance = this.credits ? await this.credits.balanceInTx(tx, job.schoolId) : 0;
        }
        return allowance;
      };

      const attempts: Array<{ id: string; channel: NotificationChannelValue; target: string; metered: boolean }> = [];
      let failed = 0;
      for (const d of pending as Array<{ id: string; channel: NotificationChannelValue }>) {
        // SAFETY: never deliver to a GENERATED login identifier — it has no
        // mailbox, so sending there drops receipts and reset links silently.
        // deliverableEmail() returns the real contactEmail, or null.
        const target = this.resolveTarget(
          d.channel,
          recipient ? deliverableEmail(recipient) : null,
          recipient?.phone ?? null,
        );
        if (!target) {
          await tx.notificationDelivery.update({
            where: { id: d.id },
            data: { status: "FAILED", error: `no target for ${d.channel}` },
          });
          failed++;
          continue;
        }
        const metered = Boolean(this.credits) && (d.channel === "SMS" || d.channel === "WHATSAPP");
        if (metered && (await remaining()) <= 0) {
          // An empty balance skips the gateway call entirely. Email and the
          // in-app inbox still go out — a school out of credit is never
          // silently cut off from its families altogether.
          await tx.notificationDelivery.update({
            where: { id: d.id },
            data: { status: "FAILED", error: "no message credits — buy a bundle on the Billing page" },
          });
          failed++;
          continue;
        }
        if (metered) allowance = (await remaining()) - 1;
        // STAMP IT BEFORE THE GATEWAY IS TOLD ANYTHING. This is what makes a
        // PENDING row afterwards mean something: with the stamp, a row still
        // PENDING and never attempted is one no worker ever picked up and is
        // safe to send; a row PENDING WITH an attempt was handed to a gateway
        // and its outcome was lost, so sending again would duplicate the
        // message and spend a second credit. Written first, and deliberately
        // in the planning transaction rather than the recording one, because
        // the recording transaction is exactly the thing that may not happen.
        await tx.notificationDelivery.update({
          where: { id: d.id },
          data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
        });
        attempts.push({ id: d.id, channel: d.channel, target, metered });
      }
      return { notification, attempts, failed };
    });
    if (!plan) return { sent: 0, failed: 0 };

    // --- 2. Talk to the gateway. NO transaction is open. ---------------------
    const outcomes: Array<{
      id: string;
      channel: NotificationChannelValue;
      target: string;
      metered: boolean;
      result: { ok: boolean; error?: string; providerRef?: string };
    }> = [];
    for (const a of plan.attempts) {
      const result = this.channels
        ? await this.channels.deliver({
            channel: a.channel,
            target: a.target,
            title: plan.notification.title,
            body: plan.notification.body,
            data: (plan.notification.data as Record<string, unknown>) ?? undefined,
          })
        : { ok: false, error: "no channel provider configured", providerRef: undefined };
      outcomes.push({ ...a, result });
    }

    // --- 3. Record what happened, and spend a credit only for a CONFIRMED send.
    let sent = 0;
    let failed = plan.failed;
    // ONE ROW MUST NOT LOSE THE TRUTH ABOUT ALL THE OTHERS.
    //
    // The gateway calls have ALREADY happened by the time we get here — this
    // transaction only writes down what they said. It used to be one
    // transaction around the whole loop, so a single failure anywhere in it
    // rolled back every OTHER outcome too: a fan-out of five hundred guardian
    // alerts, all genuinely delivered, recorded as nothing.
    //
    // Those rows then stay PENDING with an attempt stamped, which the recovery
    // sweep deliberately treats as "handed to a gateway, outcome lost — do NOT
    // re-send". So the school is told five hundred messages failed when every
    // one arrived, and no credit is spent for any of them.
    //
    // It is not hypothetical plumbing: `debitInTx` writes a ledger row and then
    // `warnIfLow` READS staff and ENQUEUES a low-balance notification, so this
    // loop does considerably more than one update per item.
    //
    // Each outcome is now its own transaction, which is what it actually is —
    // an independent fact about a different message. The debit and the status
    // stay together inside it, so a credit is never spent on a message we did
    // not manage to mark sent. A failure degrades to exactly the case the
    // recovery sweep already handles, for ONE message instead of the batch.
    for (const o of outcomes) {
      try {
        await this.db.runAsTenant(ctx, async (tx) => {
          if (o.result.ok && o.metered) {
            await this.credits!.debitInTx(tx, job.schoolId, o.channel, job.notificationId, o.result.providerRef);
          }
          await tx.notificationDelivery.update({
            where: { id: o.id },
            data: o.result.ok
              ? { status: "SENT", target: o.target, sentAt: new Date(), error: null }
              : { status: "FAILED", target: o.target, error: o.result.error ?? "delivery failed" },
          });
        });
        o.result.ok ? sent++ : failed++;
      } catch (e) {
        // Loud: the message went out and we could not write down that it did.
        // The row stays PENDING with its attempt stamped, so nothing re-sends
        // it and the delivery-problems reader will show it.
        this.logger.error(
          `delivery ${o.id} was sent on ${o.channel} but its outcome could not be recorded: ${String(e).slice(0, 160)}`,
        );
      }
    }
    return { sent, failed };
  }

  /**
   * What did NOT arrive, for the staff who send.
   *
   * Every external failure was already being recorded and nothing ever read it,
   * so a school could not learn that a fee notice bounced or that a parent's
   * number was rejected — the alert simply did not happen and every count said
   * it had. This is the reader.
   *
   * Names the recipient and the channel, never the resolved target: a failure
   * report is not a route to a phone book, and the address is on the SIS record
   * for anyone entitled to it. Scoped by RLS to the caller's own school, and the
   * `notification.send` gate keeps it to staff.
   */
  async deliveryProblems(p: Principal, opts?: { days?: number; limit?: number }): Promise<DeliveryProblemsDto> {
    const windowDays = Math.min(Math.max(opts?.days ?? 7, 1), 90);
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const since = new Date(Date.now() - windowDays * 86_400_000);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const [rows, total, pending] = await Promise.all([
        tx.notificationDelivery.findMany({
          where: { status: "FAILED", createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            id: true,
            notificationId: true,
            channel: true,
            error: true,
            attempts: true,
            createdAt: true,
            notification: { select: { title: true, type: true, recipientId: true } },
          },
        }),
        tx.notificationDelivery.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
        tx.notificationDelivery.count({ where: { status: "PENDING", createdAt: { gte: since } } }),
      ]);
      type Row = {
        id: string;
        notificationId: string;
        channel: string;
        error: string | null;
        attempts: number;
        createdAt: Date;
        notification: { title: string; type: string; recipientId: string } | null;
      };
      const list = rows as Row[];
      const ids = [...new Set(list.map((r) => r.notification?.recipientId).filter((v): v is string => !!v))];
      const people = ids.length
        ? ((await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
            id: string;
            name: string;
          }>)
        : [];
      const nameOf = new Map(people.map((u) => [u.id, u.name]));
      return {
        windowDays,
        total,
        pending,
        failures: list.map((r) => ({
          id: r.id,
          notificationId: r.notificationId,
          // A deleted account still had a message fail; say so rather than
          // dropping the row and under-reporting.
          recipientName: (r.notification?.recipientId ? nameOf.get(r.notification.recipientId) : null) ?? "Unknown",
          title: r.notification?.title ?? "",
          type: r.notification?.type ?? "",
          channel: r.channel,
          error: r.error,
          attempts: r.attempts,
          createdAt: r.createdAt,
        })),
      };
    });
  }

  // --- helpers ---------------------------------------------------------------
  private resolveTarget(channel: string, email: string | null, phone: string | null): string | null {
    if (channel === "EMAIL") return email;
    if (channel === "SMS" || channel === "WHATSAPP") return phone;
    // PUSH targets (device tokens) are not modelled yet.
    return null;
  }

  /**
   * The RECIPIENT's language: their own choice, else their school's, else the
   * platform default.
   *
   * Resolved here rather than by the producer because this is the only point
   * that knows who is being written to. `enqueueMany` already loops per
   * recipient, so a class of guardians who do not share a language each get
   * their own — which is the whole reason the key is deferred this far.
   */
  private async languageFor(tx: TenantTx, recipientId: string, schoolId: string): Promise<MessageLanguage> {
    const user = (await tx.user.findFirst({
      where: { id: recipientId },
      select: { locale: true },
    })) as { locale: string | null } | null;
    if (user?.locale) return messageLanguage(user.locale);
    // Falls back to the school. A null here is the platform default, so a school
    // that has never set a region is unchanged.
    const region = await this.regions?.forSchool(schoolId);
    return messageLanguage(region?.locale);
  }

  /**
   * Is this school switched on? Optional dependency, so a unit wiring without
   * it behaves exactly as before — the same reason `credits` and `regions` are
   * optional here. It fails OPEN rather than closed on purpose: an absent
   * status service must not silently stop every school's email.
   */
  private async schoolIsActive(schoolId: string): Promise<boolean> {
    if (!this.schoolStatus) return true;
    try {
      return await this.schoolStatus.isActive(schoolId);
    } catch {
      return true;
    }
  }

  private async persist(tx: TenantTx, actor: TenantContext, input: NotificationInput) {
    // Localise BEFORE writing, so the stored inbox row and every external
    // delivery say the same thing. Rendering at delivery time instead would let
    // a parent's SMS and their in-app inbox disagree.
    let title = input.title;
    let body = input.body;
    if (input.key) {
      const lang = await this.languageFor(tx, input.recipientId, actor.schoolId);
      const rendered = renderNotification(input.key, lang, input.params ?? {});
      // A mistyped key falls back to the producer's English text. Sending a
      // parent the literal string "attendance.absnet" would be worse than
      // sending them correct English.
      if (rendered) {
        title = rendered.title;
        body = rendered.body;
      }
    }
    const notification = await tx.notification.create({
      data: {
        schoolId: actor.schoolId,
        recipientId: input.recipientId,
        actorId: actor.userId ?? null,
        type: input.type,
        title,
        body,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    // Respect the RECIPIENT's external-channel preferences (the in-app inbox
    // row above is always created regardless). Essential types ignore per-type
    // mute; channel toggles always apply. A missing preference row = deliver all.
    const requested = [...new Set(input.channels ?? [])];
    const pref = requested.length
      ? await this.recipientPreference(tx, input.recipientId)
      : null;
    let channels = allowedChannels(pref, input.type, requested) as NotificationChannelValue[];

    // NOTHING LEAVES THE BUILDING FOR SOMEBODY WHO HAS LEFT IT.
    //
    // The inbox row above is always written — it is the record, and they cannot
    // sign in to read it anyway. External delivery is a different matter: an SMS
    // or email to a departed pupil or teacher costs the school a paid message
    // credit and sends them school information they are no longer entitled to.
    // A withdrawn child's guardian being texted about next term's fees is the
    // shape of complaint this produces.
    //
    // Checked once, HERE, rather than at each of the ~40 producers: a rule that
    // has to be remembered at every call site is one that will be missed.
    if (channels.length > 0) {
      const recipient = await tx.user.findFirst({
        where: { id: input.recipientId },
        select: { status: true },
      });
      if (recipient && recipient.status !== "ACTIVE") channels = [];
    }

    // AND NOTHING LEAVES THE BUILDING IN THE NAME OF A SCHOOL THAT IS SWITCHED
    // OFF.
    //
    // The same rule as the line above, one level up. DISABLED means nobody at
    // the school can sign in and it reaches nothing — but the platform went on
    // emailing and texting people IN THAT SCHOOL'S NAME: an overdue-boarder
    // alert to a family, a dispute warning to finance, a document-expiry
    // reminder to HR. Every one of those invites a reply to a school that
    // cannot read it, and points at a login that will be refused. The fee
    // reminder and late-fee sweeps were fixed for exactly this; they were two
    // instances of a rule that belongs in one place.
    //
    // THE INBOX ROW IS STILL WRITTEN, deliberately. Disabling deletes nothing
    // and reinstatement is total — the notices a school missed are part of "its
    // original and due state", and they are unreadable in the meantime because
    // nobody can sign in. Suppressing the record as well would make the switch
    // destructive, which is the one thing it is not.
    //
    // Operator alerts are unaffected without needing an exception: they are
    // enqueued into the PLATFORM org's own tenant, so `actor.schoolId` is the
    // platform, not the suspended school.
    if (channels.length > 0 && !(await this.schoolIsActive(actor.schoolId))) {
      this.logger.log(
        `external delivery suppressed for ${input.type} to ${input.recipientId}: school ${actor.schoolId} is not ACTIVE`,
      );
      channels = [];
    }
    for (const channel of channels) {
      await tx.notificationDelivery.create({
        data: { schoolId: actor.schoolId, notificationId: notification.id, channel },
      });
    }
    await this.audit.record(
      {
        actorId: actor.userId,
        action: "notification.create",
        entity: "notification",
        entityId: notification.id,
        schoolId: actor.schoolId,
        metadata: { recipientId: input.recipientId, type: input.type, channels },
      },
      tx,
    );
    return { notification, deliveries: channels.length };
  }

  private async queueDelivery(actor: TenantContext, notificationId: string) {
    const job: DeliverNotificationJob = {
      schoolId: actor.schoolId,
      userId: actor.userId,
      notificationId,
    };
    await this.queue.add(DELIVER_NOTIFICATION_JOB, job, {
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /** Who a staff member may send to (relationship-scoped). 403 if not allowed. */
  private async assertCanSendTo(tx: TenantTx, p: Principal, recipientId: string) {
    if (this.isSchoolWide(p)) {
      const inTenant = await tx.user.findFirst({ where: { id: recipientId }, select: { id: true } });
      if (!inTenant) throw new NotFoundException("Recipient not found");
      return;
    }
    // Teacher: students in their classes, or those students' guardians.
    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (taught.length > 0) {
      const classIds = taught.map((t: { classId: string }) => t.classId);
      const myStudents = await tx.enrollment.findMany({
        where: { status: "ACTIVE", classId: { in: classIds } },
        select: { studentId: true },
      });
      const studentIds = myStudents.map((e: { studentId: string }) => e.studentId);
      if (studentIds.includes(recipientId)) return; // a student of theirs
      const guardian = await tx.parentChild.findFirst({
        where: { parentId: recipientId, studentId: { in: studentIds } },
        select: { id: true },
      });
      if (guardian) return; // a guardian of one of their students
    }
    // SECURITY: not a permitted recipient for this sender.
    throw new ForbiddenException("Cannot send to this recipient");
  }
}
