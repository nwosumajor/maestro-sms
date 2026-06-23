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
import type { Queue } from "bullmq";
import type { NotificationChannelValue, NotificationTypeValue } from "@sms/types";
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
          select: { email: true },
        });
        const pending = await tx.notificationDelivery.findMany({
          where: { notificationId: job.notificationId, status: "PENDING" },
        });

        let sent = 0;
        let failed = 0;
        for (const d of pending) {
          const target = this.resolveTarget(d.channel, recipient?.email ?? null);
          if (!target) {
            await tx.notificationDelivery.update({
              where: { id: d.id },
              data: { status: "FAILED", error: `no target for ${d.channel}` },
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
  private resolveTarget(channel: string, email: string | null): string | null {
    if (channel === "EMAIL") return email;
    // SMS/PUSH targets (phone / device token) are not modelled yet.
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
        data: input.data ?? undefined,
      },
    });
    const channels = [...new Set(input.channels ?? [])];
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
