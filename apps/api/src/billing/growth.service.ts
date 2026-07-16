// =============================================================================
// GrowthService — promo codes + agent (reseller) commissions
// =============================================================================
// Promo codes: operator-issued percent-off on a school's FIRST paid
// subscription charge; validated at checkout with the app-role read (rls/72
// SELECT policy), redeemed (usedCount++) only when the charge SETTLES, via the
// privileged client — abandoned checkouts never burn uses.
// Agents: an attribution code stamped onto the subscription at provisioning;
// commission (bp of the charge) accrues ONCE per school on its first paid
// subscription into the append-only agent_commission ledger (privileged-only —
// the app role cannot even read it; unique schoolId is the once-only guard).

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export interface PromoValidation {
  code: string;
  percentOff: number;
}

@Injectable()
export class GrowthService {
  private readonly logger = new Logger("Growth");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** Checkout-time promo validation (app-role read). Throws a clear 400 when
   *  the code is unusable so the payer knows WHY before any charge. */
  async validatePromo(rawCode: string): Promise<PromoValidation> {
    const code = rawCode.trim().toUpperCase();
    const promo = await prisma.promoCode.findFirst({ where: { code } });
    if (!promo || !promo.active) throw new BadRequestException("That promo code is not valid");
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new BadRequestException("That promo code has expired");
    if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
      throw new BadRequestException("That promo code has been fully redeemed");
    }
    return { code: promo.code, percentOff: promo.percentOff };
  }

  /** Settle-time redemption: count the use. Best-effort (a missed increment
   *  can only UNDER-count usage — it never blocks a paid subscription). */
  async redeemPromoOnSettle(code: string): Promise<void> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn(`promo ${code} settled but no privileged DB — usedCount not incremented`);
      return;
    }
    try {
      await client.promoCode.updateMany({ where: { code }, data: { usedCount: { increment: 1 } } });
    } catch (e) {
      this.logger.warn(`promo redeem failed for ${code}: ${(e as Error).message}`);
    }
  }

  /** Accrue the agent's commission on a school's first paid subscription.
   *  Idempotent at the DB (unique schoolId); best-effort like notifications —
   *  a ledger hiccup must never fail the school's payment. */
  async accrueCommission(input: {
    schoolId: string;
    agentId: string;
    paymentRef: string;
    chargedMinor: number;
    currency: string;
  }): Promise<void> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn(`commission for school ${input.schoolId} skipped — no privileged DB`);
      return;
    }
    try {
      const agent = await client.agent.findFirst({ where: { id: input.agentId, active: true } });
      if (!agent) return;
      const amountMinor = Math.round((input.chargedMinor * agent.commissionBp) / 10_000);
      if (amountMinor <= 0) return;
      await client.agentCommission.create({
        data: {
          agentId: agent.id,
          schoolId: input.schoolId,
          paymentRef: input.paymentRef,
          amountMinor,
          currency: input.currency,
        },
      });
      this.logger.log(`commission accrued: agent=${agent.code} school=${input.schoolId} ${amountMinor} minor`);
    } catch (e) {
      // Unique violation = already accrued for this school (expected on retries).
      this.logger.debug(`commission accrual skipped for ${input.schoolId}: ${(e as Error).message}`);
    }
  }

  // --- operator console (privileged reads/writes, audited) -------------------

  private client() {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("Growth management requires the privileged database configuration");
    return c;
  }

  private async opAudit(p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action, entity: "growth", entityId, schoolId: p.schoolId, metadata },
        tx,
      ),
    );
  }

  async listPromos() {
    return this.client().promoCode.findMany({ orderBy: { createdAt: "desc" } });
  }

  async createPromo(p: Principal, input: { code: string; percentOff: number; maxUses?: number | null; expiresAt?: string | null }) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,30}$/.test(code)) throw new BadRequestException("code must be 3–30 chars, A–Z 0–9 -");
    if (!Number.isInteger(input.percentOff) || input.percentOff < 1 || input.percentOff > 100) {
      throw new BadRequestException("percentOff must be 1–100");
    }
    const promo = await this.client().promoCode.create({
      data: {
        code,
        percentOff: input.percentOff,
        maxUses: input.maxUses ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    await this.opAudit(p, "operator.promo.create", promo.id, { code, percentOff: input.percentOff, maxUses: input.maxUses ?? null });
    return promo;
  }

  async setPromoActive(p: Principal, id: string, active: boolean) {
    const res = await this.client().promoCode.updateMany({ where: { id }, data: { active } });
    if (res.count === 0) throw new NotFoundException("Promo code not found");
    await this.opAudit(p, "operator.promo.set_active", id, { active });
    return this.client().promoCode.findFirst({ where: { id } });
  }

  async listAgents() {
    const client = this.client();
    const agents = await client.agent.findMany({ orderBy: { createdAt: "desc" } });
    const sums = await client.agentCommission.groupBy({
      by: ["agentId", "status"],
      _sum: { amountMinor: true },
    });
    return agents.map((a) => ({
      ...a,
      accruedMinor: sums.find((s) => s.agentId === a.id && s.status === "ACCRUED")?._sum.amountMinor ?? 0,
      paidOutMinor: sums.find((s) => s.agentId === a.id && s.status === "PAID_OUT")?._sum.amountMinor ?? 0,
    }));
  }

  async createAgent(p: Principal, input: { name: string; email: string; code: string; commissionBp: number }) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,30}$/.test(code)) throw new BadRequestException("code must be 3–30 chars, A–Z 0–9 -");
    if (!Number.isInteger(input.commissionBp) || input.commissionBp < 1 || input.commissionBp > 5_000) {
      throw new BadRequestException("commissionBp must be 1–5000 (max 50%)");
    }
    const agent = await this.client().agent.create({
      data: { name: input.name.trim(), email: input.email.trim(), code, commissionBp: input.commissionBp },
    });
    await this.opAudit(p, "operator.agent.create", agent.id, { code, commissionBp: input.commissionBp });
    return agent;
  }

  async setAgentActive(p: Principal, id: string, active: boolean) {
    const res = await this.client().agent.updateMany({ where: { id }, data: { active } });
    if (res.count === 0) throw new NotFoundException("Agent not found");
    await this.opAudit(p, "operator.agent.set_active", id, { active });
    return this.client().agent.findFirst({ where: { id } });
  }

  async listCommissions() {
    const client = this.client();
    const rows = await client.agentCommission.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { agent: { select: { name: true, code: true } } },
    });
    const schools = await client.school.findMany({
      where: { id: { in: rows.map((r) => r.schoolId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(schools.map((s) => [s.id, s.name]));
    return rows.map((r) => ({ ...r, schoolName: nameOf.get(r.schoolId) ?? r.schoolId }));
  }

  /** Mark a commission settled to the agent (bank transfer happens outside). */
  async markCommissionPaid(p: Principal, id: string) {
    const res = await this.client().agentCommission.updateMany({
      where: { id, status: "ACCRUED" },
      data: { status: "PAID_OUT", paidOutAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException("Commission not found or already paid out");
    await this.opAudit(p, "operator.agent.commission_paid", id, {});
    return this.client().agentCommission.findFirst({ where: { id } });
  }

  /** Provisioning: resolve an agent code to its id (privileged; null when unknown). */
  async resolveAgentCode(code: string | null | undefined): Promise<string | null> {
    if (!code) return null;
    const client = this.privileged.client;
    if (!client) return null;
    const agent = await client.agent.findFirst({
      where: { code: code.trim().toUpperCase(), active: true },
      select: { id: true },
    });
    return agent?.id ?? null;
  }
}
