// =============================================================================
// OperatorCreditsService — cross-tenant message-credit (SMS/WhatsApp) oversight
// =============================================================================
// message_credit_entry is tenant-scoped + RLS-enforced (SELECT/INSERT only —
// see rls/73). Reads that must span EVERY school (the balance list, a school's
// ledger) go through the shared PRIVILEGED client, RLS-bypassing like the
// operator directory/analytics consoles — 503 when it isn't configured.
//
// The COMP/adjust write is different: it targets exactly ONE school, so it goes
// through the ordinary tenant-scoped client with the GUC set to the TARGET
// school (mirrors OperatorService.setSubscription) — the existing INSERT policy
// (schoolId = GUC) already allows it, no privileged client needed for the write
// itself. The audit row is written in a SEPARATE transaction under the
// OPERATOR's own tenant (see operator-subscription.service.spec.ts for why: an
// audit row can't carry the operator's schoolId inside the target's GUC'd tx —
// RLS WITH CHECK rejects it).
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { MessageCreditBalancePageDto, MessageCreditLedgerEntryDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

/** Most-recent ledger rows shown on a school's drill-down — an oversight view,
 *  not a full statement; matches the notifications-inbox-style cap elsewhere. */
const LEDGER_CAP = 100;

@Injectable()
export class OperatorCreditsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Best-effort, like OperatorService.auditAsOperator: the privileged effect is
   *  already committed, so a logging hiccup must never fail a completed write. */
  private async auditAsOperator(p: Principal, entry: Parameters<AuditLogService["record"]>[0]): Promise<void> {
    try {
      await this.db.runAsTenant(this.ctx(p), (tx) => this.audit.record(entry, tx));
    } catch {
      /* non-fatal, see comment above */
    }
  }

  /** Cross-tenant balance list — school-name search, paginated. */
  async listBalances(
    p: Principal,
    f: { q?: string; page?: number; pageSize?: number } = {},
  ): Promise<MessageCreditBalancePageDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Requires the privileged database configuration");
    const page = Math.max(1, Math.floor(f.page ?? 1));
    const pageSize = Math.min(Math.max(Math.floor(f.pageSize ?? 20), 1), 50);
    const where = {
      isPlatform: false,
      ...(f.q ? { name: { contains: f.q, mode: "insensitive" as const } } : {}),
    };
    const [total, schools] = await Promise.all([
      client.school.count({ where }),
      client.school.findMany({
        where,
        select: { id: true, name: true },
        orderBy: { name: "asc" as const },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const schoolIds = schools.map((s) => s.id);
    // One grouped aggregate for the whole page, keyed by (school, reason) — not
    // an N-query loop. `by` needs both columns since totals are reason-split.
    const sums = schoolIds.length
      ? await client.messageCreditEntry.groupBy({
          by: ["schoolId", "reason"],
          where: { schoolId: { in: schoolIds } },
          _sum: { deltaCredits: true },
        })
      : [];
    const agg = new Map<string, { balance: number; purchased: number; sent: number; adjusted: number }>();
    for (const s of schools) agg.set(s.id, { balance: 0, purchased: 0, sent: 0, adjusted: 0 });
    for (const row of sums) {
      const a = agg.get(row.schoolId);
      if (!a) continue;
      const v = row._sum.deltaCredits ?? 0;
      a.balance += v;
      if (row.reason === "PURCHASE") a.purchased += v;
      // SEND rows are stored as negative deltas; report consumption as a
      // positive count ("2,341 sent"), not a confusing negative number.
      else if (row.reason === "SEND") a.sent += -v;
      else if (row.reason === "ADJUST") a.adjusted += v;
    }
    const rows = schools.map((s) => {
      const a = agg.get(s.id)!;
      return {
        schoolId: s.id,
        schoolName: s.name,
        balance: a.balance,
        totalPurchased: a.purchased,
        totalSent: a.sent,
        totalAdjusted: a.adjusted,
      };
    });
    return { rows, total, page, pageSize };
  }

  /** One school's ledger, newest first — purchases, sends, and operator comps. */
  async listLedger(p: Principal, schoolId: string): Promise<MessageCreditLedgerEntryDto[]> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Requires the privileged database configuration");
    // 404-not-403 even for the operator: don't oracle which ids exist.
    const school = await client.school.findFirst({ where: { id: schoolId, isPlatform: false }, select: { id: true } });
    if (!school) throw new NotFoundException("School not found");
    const rows = await client.messageCreditEntry.findMany({
      where: { schoolId },
      orderBy: { createdAt: "desc" },
      take: LEDGER_CAP,
    });
    return rows.map((r) => ({
      id: r.id,
      deltaCredits: r.deltaCredits,
      reason: r.reason,
      channel: r.channel,
      reference: r.reference,
      createdAt: r.createdAt,
    }));
  }

  /** Comp or debit a school's credit balance (super_admin only — a revenue
   *  lever, like the subscription comp). Always a NEW append-only ledger row,
   *  never an edit — the same evidentiary posture as a purchase or a send. */
  async adjust(p: Principal, schoolId: string, delta: number, note: string): Promise<{ ok: true; newBalance: number }> {
    if (!Number.isInteger(delta) || delta === 0) throw new BadRequestException("delta must be a non-zero integer");
    const trimmed = note.trim();
    if (!trimmed) throw new BadRequestException("A reason note is required for a credit adjustment");

    const newBalance = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      await tx.messageCreditEntry.create({
        data: { schoolId, deltaCredits: delta, reason: "ADJUST", reference: trimmed.slice(0, 200) },
      });
      const sum = await tx.messageCreditEntry.aggregate({ where: { schoolId }, _sum: { deltaCredits: true } });
      return sum._sum.deltaCredits ?? 0;
    });

    await this.auditAsOperator(p, {
      actorId: p.userId,
      action: "operator.credits.adjust",
      entity: "message_credit_entry",
      entityId: schoolId,
      schoolId: p.schoolId,
      metadata: { targetSchoolId: schoolId, delta, note: trimmed, newBalance },
    });
    return { ok: true, newBalance };
  }
}
