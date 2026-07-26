// =============================================================================
// FeedbackService — platform feedback (complaints + feature suggestions)
// =============================================================================
// Any signed-in user sends a COMPLAINT or SUGGESTION to the platform owner. The
// row is tenant-scoped (the sender's school owns it, RLS) so a sender only ever
// sees their OWN feedback; the platform owner reads + reviews ACROSS tenants via
// the PRIVILEGED client (the operator/scholarship posture). Reviewers are alerted
// on submit. Append-only to the sender (no UPDATE/DELETE grant) — only the review
// path mutates it, cross-tenant.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { MyFeedbackDto, PageDto, PlatformFeedbackDto } from "@sms/types";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { decodeCursor, encodeCursor, pageLimit, seekWhere } from "../common/keyset-cursor";

interface FeedbackRow {
  id: string;
  userId: string;
  schoolId: string;
  kind: string;
  subject: string;
  body: string;
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class FeedbackService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Any authenticated user sends feedback to the platform owner. */
  async send(p: Principal, input: { kind: string; subject: string; body: string }): Promise<{ id: string }> {
    if (!FEEDBACK_KINDS.includes(input.kind as never)) throw new BadRequestException("Invalid feedback kind");
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = (await tx.platformFeedback.create({
        data: { schoolId: p.schoolId, userId: p.userId, kind: input.kind, subject: input.subject, body: input.body },
      })) as { id: string };
      await this.log(tx, p, "feedback.send", r.id, { kind: input.kind });
      return r;
    });
    // Alert the platform reviewers (cross-tenant, so via the privileged client);
    // best-effort — a notification hiccup must never fail the submission.
    await this.alertReviewers(input.kind, input.subject).catch(() => undefined);
    return { id: row.id };
  }

  /** The sender's own submissions (tenant-scoped read). */
  async listMine(p: Principal): Promise<MyFeedbackDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.platformFeedback.findMany({ where: { userId: p.userId }, orderBy: { createdAt: "desc" }, take: 100 })) as FeedbackRow[];
      return rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, body: r.body, status: r.status, reviewNote: r.reviewNote, createdAt: r.createdAt }));
    });
  }

  /** Platform owner: the cross-tenant inbox (keyset-paged). Privileged read. */
  async listAll(p: Principal, opts: { cursor?: string; limit?: number; status?: string } = {}): Promise<PageDto<PlatformFeedbackDto>> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Feedback review requires the privileged database configuration");
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    const where: Record<string, unknown> = { ...seekWhere(cursor) };
    if (opts.status && FEEDBACK_STATUSES.includes(opts.status as never)) where.status = opts.status;
    const rows = (await client.platformFeedback.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    })) as FeedbackRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    // Batch the sender + school names (one query each) — never per row.
    const userIds = [...new Set(items.map((r) => r.userId))];
    const schoolIds = [...new Set(items.map((r) => r.schoolId))];
    const [users, schools] = await Promise.all([
      userIds.length ? client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      schoolIds.length ? client.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    const schoolOf = new Map(schools.map((s: { id: string; name: string }) => [s.id, s.name]));
    return {
      items: items.map((r) => ({
        id: r.id,
        kind: r.kind,
        subject: r.subject,
        body: r.body,
        status: r.status,
        reviewNote: r.reviewNote,
        reviewedAt: r.reviewedAt,
        senderName: nameOf.get(r.userId) ?? "Unknown",
        schoolName: schoolOf.get(r.schoolId) ?? "Unknown school",
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
    };
  }

  /** Platform owner: set a status + optional note. Privileged (cross-tenant). */
  async review(p: Principal, id: string, input: { status: string; note?: string | null }): Promise<{ ok: true }> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Feedback review requires the privileged database configuration");
    if (!FEEDBACK_STATUSES.includes(input.status as never)) throw new BadRequestException("Invalid status");
    const existing = await client.platformFeedback.findFirst({ where: { id }, select: { id: true, schoolId: true } });
    if (!existing) throw new NotFoundException("Feedback not found");
    await client.platformFeedback.update({
      where: { id },
      data: { status: input.status, reviewNote: input.note ?? null, reviewedById: p.userId, reviewedAt: new Date() },
    });
    // Audit in the reviewer's own tenant (the platform org); the entity carries
    // the sender's schoolId so the trail is complete.
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "feedback.review", entity: "platform_feedback", entityId: id, schoolId: p.schoolId, metadata: { status: input.status, senderSchoolId: existing.schoolId } },
        tx,
      ),
    );
    return { ok: true as const };
  }

  private async alertReviewers(kind: string, subject: string): Promise<void> {
    const client = this.privileged.client;
    if (!client) return; // no privileged client in this deploy → silently skip
    const reviewers = await client.user.findMany({
      where: { roles: { some: { role: { name: { in: ["super_admin", "manager_admin"] } } } } },
      select: { id: true, schoolId: true },
    });
    for (const r of reviewers) {
      await this.notifications.enqueue(
        { schoolId: r.schoolId, userId: r.id },
        {
          recipientId: r.id,
          type: "OPERATOR_ALERT",
          title: `New ${kind === "SUGGESTION" ? "suggestion" : "complaint"}: ${subject}`,
          body: `A school user sent platform feedback (${kind.toLowerCase()}). Review it in the operator feedback inbox.`,
          channels: ["EMAIL"],
        },
      );
    }
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record({ actorId: p.userId, action, entity: "platform_feedback", entityId, schoolId: p.schoolId, metadata }, tx);
  }
}
