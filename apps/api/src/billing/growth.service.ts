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
import { PLATFORM_HOME_CURRENCY } from "@sms/types";
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
    if (promo.maxUses != null) {
      // THE BUDGET HAS TO COUNT WHAT IS ALREADY IN FLIGHT.
      //
      // `usedCount` is incremented at SETTLE and this check ran at CHECKOUT, so
      // between the two the code was unlocked — and that gap is not a
      // millisecond race, it is however long a payer takes on the gateway.
      // Measured: a code with `maxUses: 1` produced THREE live discounted
      // charges from one school, and across schools it is unbounded. `maxUses`
      // is money the owner decided to give away, so a control that does not
      // bound it is not a control.
      //
      // Two numbers, each meaning one thing: `usedCount` is what has actually
      // been redeemed, and the PENDING charges carrying this code are what is
      // in flight. No second counter of the same fact, so nothing can drift —
      // and the dunning sweep's `expireStaleIntents` marks an abandoned
      // checkout ABANDONED, which releases its share of the budget without a
      // sweep of our own.
      const inFlight = await this.inFlightRedemptions(promo.code);
      if (promo.usedCount + inFlight >= promo.maxUses) {
        throw new BadRequestException(
          inFlight > 0 && promo.usedCount < promo.maxUses
            ? "That promo code is fully committed — every remaining use is on a checkout in progress. Try again shortly."
            : "That promo code has been fully redeemed",
        );
      }
    }
    return { code: promo.code, percentOff: promo.percentOff };
  }

  /**
   * Checkouts carrying this code that have started and not finished.
   *
   * PRIVILEGED, because the count is across every school and
   * `platform_subscription_payment` is tenant-scoped — an app-role read under
   * no GUC returns nothing, which would silently restore the hole.
   *
   * FALLS BACK TO ZERO when there is no privileged client, which is what this
   * check did before it existed. Refusing every promo checkout because a
   * database URL is unset would be a self-inflicted outage over a giveaway
   * budget, and the log says which happened.
   */
  private async inFlightRedemptions(code: string): Promise<number> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn(`promo ${code}: no privileged DB — in-flight checkouts not counted against maxUses`);
      return 0;
    }
    try {
      return await client.platformSubscriptionPayment.count({
        where: { promoCode: code, status: "PENDING" },
      });
    } catch (e) {
      this.logger.warn(`promo ${code}: could not count in-flight checkouts: ${(e as Error).message}`);
      return 0;
    }
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

  /**
   * Agents with what they are owed, PER CURRENCY.
   *
   * `agent_commission` has carried a `currency` column since it was created,
   * because a subscription settles in naira through Paystack or in dollars
   * through Stripe and the commission accrues on that charge. The aggregate
   * grouped by `["agentId", "status"]` and dropped it, so an agent with one
   * Nigerian school and one American one had kobo added to cents — the same
   * defect the operator revenue ledger beside this one refuses by design ("money
   * is NEVER summed across currencies ... the shape of the answer is what stops
   * the mistake being reintroduced"). This is a payout figure: somebody is paid
   * it.
   *
   * Grouping by one more column costs nothing — same scan, same round trip.
   */
  async listAgents() {
    const client = this.client();
    const agents = await client.agent.findMany({ orderBy: { createdAt: "desc" } });
    // reason: groupBy's generated overload cannot express a three-column `by`
    // here; the argument shape is correct and the RESULT is typed on the line
    // below — the same treatment `OperatorPaymentsService.totals` uses.
    const groupBy = client.agentCommission.groupBy as unknown as (
      args: Record<string, unknown>,
    ) => Promise<Array<{ agentId: string; status: string; currency: string; _sum: { amountMinor: number | null } }>>;
    const sums = await groupBy({ by: ["agentId", "status", "currency"], _sum: { amountMinor: true } });
    return agents.map((a) => {
      const mine = sums.filter((s) => s.agentId === a.id);
      const byCurrency = [...new Set(mine.map((s) => s.currency))]
        .sort()
        .map((currency) => ({
          currency,
          accruedMinor: mine.find((s) => s.currency === currency && s.status === "ACCRUED")?._sum.amountMinor ?? 0,
          paidOutMinor: mine.find((s) => s.currency === currency && s.status === "PAID_OUT")?._sum.amountMinor ?? 0,
        }));
      // An agent with no commissions still reads as a row, in the platform's own
      // currency — an empty list would render as nothing at all where a zero
      // belongs.
      return {
        ...a,
        byCurrency: byCurrency.length > 0 ? byCurrency : [{ currency: PLATFORM_HOME_CURRENCY, accruedMinor: 0, paidOutMinor: 0 }],
      };
    });
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

}
