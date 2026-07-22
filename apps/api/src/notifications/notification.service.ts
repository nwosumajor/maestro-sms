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
import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { MessageCreditsService } from "./message-credits.service";
import { Prisma } from "@sms/db";
import type { Queue } from "bullmq";
import type { NotificationChannelValue, NotificationTypeValue, NotificationPreferenceDto } from "@sms/types";
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

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal", "super_admin"]);

export interface NotificationInput {
  recipientId: string;
  type: NotificationTypeValue | string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** External channels to ALSO deliver. In-app is always created. */
  channels?: NotificationChannelValue[];
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
  async listMine(p: Principal, opts?: { unreadOnly?: boolean }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = { recipientId: p.userId };
      if (opts?.unreadOnly) where.readAt = null;
      const [items, unread] = await Promise.all([
        tx.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
        tx.notification.count({ where: { recipientId: p.userId, readAt: null } }),
      ]);
      return { items, unread };
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
  async runDeliveries(job: DeliverNotificationJob): Promise<{ sent: number; failed: number }> {
    return this.db.runAsTenant(
      { schoolId: job.schoolId, userId: job.userId },
      async (tx) => {
        const notification = await tx.notification.findFirst({
          where: { id: job.notificationId },
        });
        if (!notification) return { sent: 0, failed: 0 };
        const recipient = await tx.user.findFirst({
          where: { id: notification.recipientId },
          select: { email: true, contactEmail: true, phone: true },
        });
        const pending = await tx.notificationDelivery.findMany({
          where: { notificationId: job.notificationId, status: "PENDING" },
        });

        let sent = 0;
        let failed = 0;
        for (const d of pending) {
          // SAFETY: never deliver to a GENERATED login identifier — it has no
          // mailbox, so sending there drops receipts and reset links silently.
          // deliverableEmail() returns the real contactEmail, or null; the null
          // is then recorded as a real FAILED delivery the operator can see.
          const mailTo = recipient ? deliverableEmail(recipient) : null;
          const target = this.resolveTarget(d.channel, mailTo, recipient?.phone ?? null);
          if (!target) {
            await tx.notificationDelivery.update({
              where: { id: d.id },
              data: { status: "FAILED", error: `no target for ${d.channel}` },
            });
            failed++;
            continue;
          }
          // SMS/WhatsApp are METERED: an empty balance skips the gateway call
          // entirely (email + in-app still go out — parents are never silently
          // cut off entirely). The credit itself is spent only AFTER a CONFIRMED
          // send below — a gateway failure must never consume a paid credit.
          const metered = this.credits && (d.channel === "SMS" || d.channel === "WHATSAPP");
          if (metered && !(await this.credits!.hasBalanceInTx(tx, job.schoolId))) {
            await tx.notificationDelivery.update({
              where: { id: d.id },
              data: { status: "FAILED", error: "no message credits — buy a bundle on the Billing page" },
            });
            failed++;
            continue;
          }
          const result = this.channels
            ? await this.channels.deliver({
                channel: d.channel,
                target,
                title: notification.title,
                body: notification.body,
                data: (notification.data as Record<string, unknown>) ?? undefined,
              })
            : { ok: false, error: "no channel provider configured" };
          if (result.ok && metered) {
            await this.credits!.debitInTx(tx, job.schoolId, d.channel, job.notificationId);
          }
          await tx.notificationDelivery.update({
            where: { id: d.id },
            data: result.ok
              ? { status: "SENT", target, sentAt: new Date(), error: null }
              : { status: "FAILED", target, error: result.error ?? "delivery failed" },
          });
          result.ok ? sent++ : failed++;
        }
        return { sent, failed };
      },
    );
  }

  // --- helpers ---------------------------------------------------------------
  private resolveTarget(channel: string, email: string | null, phone: string | null): string | null {
    if (channel === "EMAIL") return email;
    if (channel === "SMS" || channel === "WHATSAPP") return phone;
    // PUSH targets (device tokens) are not modelled yet.
    return null;
  }

  private async persist(tx: TenantTx, actor: TenantContext, input: NotificationInput) {
    const notification = await tx.notification.create({
      data: {
        schoolId: actor.schoolId,
        recipientId: input.recipientId,
        actorId: actor.userId ?? null,
        type: input.type,
        title: input.title,
        body: input.body,
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
    const channels = allowedChannels(pref, input.type, requested) as NotificationChannelValue[];
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
        where: { classId: { in: classIds } },
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
