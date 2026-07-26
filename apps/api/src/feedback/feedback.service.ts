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

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { FeedbackStatsDto, MyFeedbackDto, PageDto, PlatformFeedbackDto } from "@sms/types";
import { FEEDBACK_BULK_MAX, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "@sms/types";
import {
  FEEDBACK_DIGEST_WINDOW_MS,
  FEEDBACK_USER_HOURLY_CAP,
  FEEDBACK_USER_WINDOW_MS,
} from "./feedback.constants";
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

  /**
   * Any authenticated user sends feedback to the platform owner.
   *
   * At volume (thousands/day) this hot path stays cheap and abuse-resistant:
   *  - a per-USER rolling-hour cap (DB count over the (userId,createdAt) index)
   *    stops one account flooding 5000 — cross-instance correct, no per-request
   *    Redis needed;
   *  - NO per-submission owner alert. Alerting is COALESCED into an hourly digest
   *    (FeedbackDigestProcessor → digestSweep) so 5000 submissions become ~24
   *    summary emails, not 5000 — cheaper and vastly more triageable.
   */
  async send(p: Principal, input: { kind: string; subject: string; body: string }): Promise<{ id: string }> {
    if (!FEEDBACK_KINDS.includes(input.kind as never)) throw new BadRequestException("Invalid feedback kind");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const since = new Date(Date.now() - FEEDBACK_USER_WINDOW_MS);
      const recent = await tx.platformFeedback.count({ where: { userId: p.userId, createdAt: { gte: since } } });
      if (recent >= FEEDBACK_USER_HOURLY_CAP) {
        throw new HttpException("You've sent a lot of feedback in a short time — please try again later.", HttpStatus.TOO_MANY_REQUESTS);
      }
      const r = (await tx.platformFeedback.create({
        data: { schoolId: p.schoolId, userId: p.userId, kind: input.kind, subject: input.subject, body: input.body },
      })) as { id: string };
      await this.log(tx, p, "feedback.send", r.id, { kind: input.kind });
      return { id: r.id };
    });
  }

  /** The sender's own submissions (tenant-scoped read). */
  async listMine(p: Principal): Promise<MyFeedbackDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.platformFeedback.findMany({ where: { userId: p.userId }, orderBy: { createdAt: "desc" }, take: 100 })) as FeedbackRow[];
      return rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, body: r.body, status: r.status, reviewNote: r.reviewNote, createdAt: r.createdAt }));
    });
  }

  /** Platform owner: the cross-tenant inbox (keyset-paged). Privileged read. */
  async listAll(
    p: Principal,
    opts: { cursor?: string; limit?: number; status?: string; kind?: string } = {},
  ): Promise<PageDto<PlatformFeedbackDto>> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Feedback review requires the privileged database configuration");
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    const where: Record<string, unknown> = { ...seekWhere(cursor) };
    if (opts.status && FEEDBACK_STATUSES.includes(opts.status as never)) where.status = opts.status;
    if (opts.kind && FEEDBACK_KINDS.includes(opts.kind as never)) where.kind = opts.kind;
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

  /**
   * Bulk-review — set ONE status on up to FEEDBACK_BULK_MAX ids in a single
   * updateMany. Essential at volume: 5000/day is untriageable one row at a time,
   * so the owner can select many and dismiss/resolve in a single cheap query.
   */
  async bulkReview(p: Principal, ids: string[], input: { status: string; note?: string | null }): Promise<{ updated: number }> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Feedback review requires the privileged database configuration");
    if (!FEEDBACK_STATUSES.includes(input.status as never)) throw new BadRequestException("Invalid status");
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) throw new BadRequestException("No feedback selected");
    if (unique.length > FEEDBACK_BULK_MAX) throw new BadRequestException(`At most ${FEEDBACK_BULK_MAX} at a time`);
    const res = await client.platformFeedback.updateMany({
      where: { id: { in: unique } },
      data: { status: input.status, reviewNote: input.note ?? null, reviewedById: p.userId, reviewedAt: new Date() },
    });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "feedback.bulk_review", entity: "platform_feedback", entityId: "bulk", schoolId: p.schoolId, metadata: { status: input.status, count: res.count } },
        tx,
      ),
    );
    return { updated: res.count };
  }

  /**
   * Aggregate triage counts — ONE grouped query, so the inbox header is O(groups)
   * not O(rows). Lets the owner see the shape of the backlog at a glance.
   */
  async stats(): Promise<FeedbackStatsDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Feedback review requires the privileged database configuration");
    // One scan, one round-trip — conditional FILTER counts (the analytics pattern).
    // stats is loaded a handful of times a day by the owner (not per submission),
    // so a single aggregate over the table is fine even at millions of rows.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = (await client.$queryRaw`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'OPEN')::int AS open,
        count(*) FILTER (WHERE status = 'REVIEWED')::int AS reviewed,
        count(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
        count(*) FILTER (WHERE status = 'DISMISSED')::int AS dismissed,
        count(*) FILTER (WHERE kind = 'COMPLAINT')::int AS complaints,
        count(*) FILTER (WHERE kind = 'SUGGESTION')::int AS suggestions,
        count(*) FILTER (WHERE status = 'OPEN' AND "createdAt" >= ${since})::int AS last24h
      FROM platform_feedback
    `) as Array<{
      total: number;
      open: number;
      reviewed: number;
      resolved: number;
      dismissed: number;
      complaints: number;
      suggestions: number;
      last24h: number;
    }>;
    const r = rows[0];
    return {
      total: r?.total ?? 0,
      open: r?.open ?? 0,
      reviewed: r?.reviewed ?? 0,
      resolved: r?.resolved ?? 0,
      dismissed: r?.dismissed ?? 0,
      complaints: r?.complaints ?? 0,
      suggestions: r?.suggestions ?? 0,
      last24h: r?.last24h ?? 0,
    };
  }

  /**
   * Digest sweep — the coalesced replacement for per-submission alerts. Runs
   * hourly (or on-demand). Counts OPEN feedback in the trailing window; if any is
   * new, sends ONE summary notification+email to each reviewer with the new count
   * + the total open backlog. Privileged (cross-tenant); disabled (no-op) when no
   * privileged client is configured. Idempotent-ish: a quiet window notifies
   * no-one, so 5000/day becomes ~24 emails, never 5000.
   */
  async digestSweep(): Promise<{ notified: number; newOpen: number }> {
    const client = this.privileged.client;
    if (!client) return { notified: 0, newOpen: 0 };
    const since = new Date(Date.now() - FEEDBACK_DIGEST_WINDOW_MS);
    const newOpen = await client.platformFeedback.count({ where: { status: "OPEN", createdAt: { gte: since } } });
    if (newOpen === 0) return { notified: 0, newOpen: 0 };
    const totalOpen = await client.platformFeedback.count({ where: { status: "OPEN" } });
    const reviewers = (await client.user.findMany({
      where: { roles: { some: { role: { name: { in: ["super_admin", "manager_admin"] } } } } },
      select: { id: true, schoolId: true },
    })) as { id: string; schoolId: string }[];
    let notified = 0;
    for (const r of reviewers) {
      await this.notifications
        .enqueue(
          { schoolId: r.schoolId, userId: r.id },
          {
            recipientId: r.id,
            type: "OPERATOR_ALERT",
            title: `${newOpen} new feedback item${newOpen === 1 ? "" : "s"} — ${totalOpen} open`,
            body: `${newOpen} new complaint(s)/suggestion(s) arrived in the last hour. ${totalOpen} open in total. Review them in the operator feedback inbox.`,
            channels: ["EMAIL"],
          },
        )
        .then(() => {
          notified += 1;
        })
        .catch(() => undefined); // one bad recipient must not abort the digest
    }
    return { notified, newOpen };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record({ actorId: p.userId, action, entity: "platform_feedback", entityId, schoolId: p.schoolId, metadata }, tx);
  }
}
