// =============================================================================
// MessagingService — threaded two-way messages, participant-scoped
// =============================================================================
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";

const STAFF = new Set(["school_admin", "principal", "super_admin"]);
const STAFF_OR_TEACHER = new Set(["teacher", "school_admin", "principal", "accountant", "hr_clerk", "board"]);

@Injectable()
export class MessagingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Users the caller may start a thread with (staff: everyone; else staff/teachers). */
  async contacts(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const [users, roles] = await Promise.all([
        tx.user.findMany({ select: { id: true, name: true, roles: { select: { roleId: true } } }, orderBy: { name: "asc" } }),
        tx.role.findMany({ select: { id: true, name: true } }),
      ]);
      const roleName = new Map(roles.map((r: { id: string; name: string }) => [r.id, r.name]));
      const staff = p.roles.some((r) => STAFF.has(r));
      return (users as Array<{ id: string; name: string; roles: { roleId: string }[] }>)
        .map((u) => ({ id: u.id, name: u.name, roles: u.roles.map((r) => roleName.get(r.roleId)).filter(Boolean) as string[] }))
        .filter((u) => u.id !== p.userId && (staff || u.roles.some((n) => STAFF_OR_TEACHER.has(n))));
    });
  }

  async listThreads(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const parts = await tx.threadParticipant.findMany({
        where: { userId: p.userId },
        select: { threadId: true, lastReadAt: true },
      });
      const ids = parts.map((x: { threadId: string }) => x.threadId);
      if (ids.length === 0) return [];
      const lastRead = new Map(parts.map((x: { threadId: string; lastReadAt: Date | null }) => [x.threadId, x.lastReadAt]));
      const threads = await tx.messageThread.findMany({ where: { id: { in: ids } }, orderBy: { updatedAt: "desc" } });
      const out = [];
      for (const t of threads as Array<{ id: string; subject: string; updatedAt: Date }>) {
        const last = await tx.message.findFirst({ where: { threadId: t.id }, orderBy: { createdAt: "desc" } });
        const lr = lastRead.get(t.id);
        const unread = await tx.message.count({
          where: { threadId: t.id, senderId: { not: p.userId }, ...(lr ? { createdAt: { gt: lr } } : {}) },
        });
        out.push({ ...t, lastMessage: last, unread });
      }
      return out;
    });
  }

  async getThread(p: Principal, threadId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertParticipant(tx, p, threadId);
      const [thread, messages] = await Promise.all([
        tx.messageThread.findFirst({ where: { id: threadId } }),
        tx.message.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } }),
      ]);
      // assertParticipant guarantees the thread exists; satisfy the type.
      if (!thread) throw new NotFoundException("Thread not found");
      await tx.threadParticipant.updateMany({
        where: { threadId, userId: p.userId },
        data: { lastReadAt: new Date() },
      });
      return { thread, messages };
    });
  }

  async createThread(p: Principal, input: { recipientId: string; subject: string; body: string }) {
    const thread = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanMessage(tx, p, input.recipientId);
      const t = await tx.messageThread.create({
        data: { schoolId: p.schoolId, subject: input.subject, createdById: p.userId },
      });
      await tx.threadParticipant.create({ data: { schoolId: p.schoolId, threadId: t.id, userId: p.userId, lastReadAt: new Date() } });
      await tx.threadParticipant.create({ data: { schoolId: p.schoolId, threadId: t.id, userId: input.recipientId } });
      await tx.message.create({ data: { schoolId: p.schoolId, threadId: t.id, senderId: p.userId, body: input.body } });
      return { thread: t, recipientId: input.recipientId, subject: input.subject };
    });
    await this.notify(p, [thread.recipientId], thread.subject);
    return thread.thread;
  }

  async reply(p: Principal, threadId: string, body: string) {
    const res = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertParticipant(tx, p, threadId);
      const msg = await tx.message.create({ data: { schoolId: p.schoolId, threadId, senderId: p.userId, body } });
      await tx.messageThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
      await tx.threadParticipant.updateMany({ where: { threadId, userId: p.userId }, data: { lastReadAt: new Date() } });
      const others = await tx.threadParticipant.findMany({
        where: { threadId, userId: { not: p.userId } },
        select: { userId: true },
      });
      const thread = await tx.messageThread.findFirst({ where: { id: threadId }, select: { subject: true } });
      return { msg, recipients: others.map((o: { userId: string }) => o.userId), subject: thread?.subject ?? "Message" };
    });
    await this.notify(p, res.recipients, res.subject);
    return res.msg;
  }

  // --- helpers ---------------------------------------------------------------
  private async assertParticipant(tx: TenantTx, p: Principal, threadId: string) {
    const part = await tx.threadParticipant.findFirst({ where: { threadId, userId: p.userId }, select: { id: true } });
    if (!part) throw new NotFoundException("Thread not found");
  }

  private async assertCanMessage(tx: TenantTx, p: Principal, recipientId: string) {
    const recipient = await tx.user.findFirst({ where: { id: recipientId }, select: { id: true } });
    if (!recipient) throw new NotFoundException("Recipient not found");
    if (p.roles.some((r) => STAFF.has(r))) return;
    const rr = await tx.userRole.findMany({ where: { userId: recipientId }, include: { role: { select: { name: true } } } });
    const names = (rr as Array<{ role: { name: string } }>).map((x) => x.role.name);
    if (names.some((n) => STAFF_OR_TEACHER.has(n))) return;
    throw new ForbiddenException("You can only message staff and teachers");
  }

  private async notify(p: Principal, recipientIds: string[], subject: string) {
    try {
      for (const id of recipientIds) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: id,
          type: "GENERIC",
          title: "New message",
          body: `You have a new message: "${subject}".`,
        });
      }
    } catch {
      /* best-effort */
    }
  }
}
