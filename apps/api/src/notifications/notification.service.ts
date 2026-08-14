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
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { MessageCreditsService } from "./message-credits.service";
import { Prisma } from "@sms/db";
import type { Queue } from "bullmq";
import type { NotificationChannelValue, NotificationTypeValue, NotificationPreferenceDto, MessageLanguage } from "@sms/types";
import { MESSAGE_LANGUAGES, messageLanguage, renderNotification } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
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
  async listMine(p: Principal, opts?: { unreadOnly?: boolean; limit?: number }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = { recipientId: p.userId };
      if (opts?.unreadOnly) where.readAt = null;
      // The dashboard shows six; the inbox page shows the full hundred. Fetching a
      // hundred rows to render six is the kind of waste that only shows up as a
      // slow home page nobody can attribute to anything.
      const take = Math.min(Math.max(opts?.limit ?? 100, 1), 100);
      const [items, unread] = await Promise.all([
        tx.notification.findMany({ where, orderBy: { createdAt: "desc" }, take }),
        tx.notification.count({ where: { recipientId: p.userId, readAt: null } }),
      ]);
      return { items, unread };
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
    await this.db.runAsTenant(ctx, async (tx) => {
      for (const o of outcomes) {
        if (o.result.ok && o.metered) {
          await this.credits!.debitInTx(tx, job.schoolId, o.channel, job.notificationId, o.result.providerRef);
        }
        await tx.notificationDelivery.update({
          where: { id: o.id },
          data: o.result.ok
            ? { status: "SENT", target: o.target, sentAt: new Date(), error: null }
            : { status: "FAILED", target: o.target, error: o.result.error ?? "delivery failed" },
        });
        o.result.ok ? sent++ : failed++;
      }
    });
    return { sent, failed };
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
