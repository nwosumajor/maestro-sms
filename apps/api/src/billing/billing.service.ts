// =============================================================================
// BillingService — school self-serve platform subscription (per-seat, Paystack)
// =============================================================================
// A school's principal/school_admin picks a tier and pays for it. Pricing is
// per-seat (active students × the tier's monthly rate × the cycle's months).
// Money is integer MINOR units (kobo), NGN. A checkout creates a PENDING
// platform_subscription_payment and hands off to Paystack; the verified webhook
// (dispatched here by metadata.kind) flips it PAID and EXTENDS the subscription's
// currentPeriodEnd. Delinquency is enforced by ModuleEntitlementService (effective
// plan), never by mutating the purchased `plan` here.
//
// Tenant isolation: every read/write runs under runAsTenant (RLS); the webhook
// write runs in a system-context tenant transaction keyed on the metadata's
// schoolId (mirrors the Fees online-payment webhook). Mutations are audit-logged.
// =============================================================================

import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  DEFAULT_PLAN,
  PLANS,
  SUBSCRIPTION_STATUS,
  computeSubscriptionPriceMinor,
  isBillingCycle,
  isPlan,
  type BillingCycle,
  type BillingOverviewDto,
  type CheckoutInitResultDto,
  type Plan,
  type PlatformPaymentDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";
import { NotificationService } from "../notifications/notification.service";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { SYSTEM_ACTOR_ID } from "./billing.constants";
import { BillingDunningService, type DunningResult } from "./billing-dunning.service";
import { PlanPricingService } from "./plan-pricing.service";

/** Tiers a school can actually buy (all four are paid; STANDARD is the floor). */
const SELLABLE_TIERS: Plan[] = [PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE];
const QUOTE_CYCLES: BillingCycle[] = [BILLING_CYCLES.MONTH, BILLING_CYCLES.TERM, BILLING_CYCLES.YEAR];

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
    private readonly dunning: BillingDunningService,
    private readonly planPricing: PlanPricingService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Active students = distinct users holding the `student` role in this school. */
  private async activeStudents(tx: TenantTx): Promise<number> {
    const rows = await tx.userRole.findMany({
      where: { role: { name: "student" } },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.length;
  }

  private toPaymentDto(r: {
    id: string;
    reference: string;
    plan: string;
    billingCycle: string;
    seats: number;
    amountMinor: number;
    status: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    paidAt: Date | null;
    createdAt: Date;
  }): PlatformPaymentDto {
    return {
      id: r.id,
      reference: r.reference,
      plan: r.plan as Plan,
      billingCycle: r.billingCycle as BillingCycle,
      seats: r.seats,
      amountMinor: r.amountMinor,
      status: r.status,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    };
  }

  /** Light subscription posture only — the AppShell renewal/past-due banner.
   *  (No payments/quotes: this is fetched on every page render for billing.read
   *  holders, so it must stay cheap — one cached entitlement resolution.) */
  async getStatus(p: Principal) {
    const resolved = await this.entitlements.resolve(p.schoolId);
    return this.entitlements.dtoFrom(p.schoolId, resolved);
  }

  /** Current subscription + live per-tier quotes + payment history. */
  async getOverview(p: Principal): Promise<BillingOverviewDto> {
    const resolved = await this.entitlements.resolve(p.schoolId);
    const subscription = this.entitlements.dtoFrom(p.schoolId, resolved);

    const { activeStudents, payments } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const seats = await this.activeStudents(tx);
      const rows = await tx.platformSubscriptionPayment.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { activeStudents: seats, payments: rows.map((r) => this.toPaymentDto(r)) };
    });

    const billableSeats = Math.max(1, activeStudents);
    // Quote with the operator-effective pricing so the screen matches checkout.
    const pricing = await this.planPricing.effective();
    const quotes = SELLABLE_TIERS.flatMap((plan) =>
      QUOTE_CYCLES.map((cycle) => ({
        plan,
        billingCycle: cycle,
        seats: billableSeats,
        priceMinor: computeSubscriptionPriceMinor(plan, billableSeats, cycle, pricing),
      })),
    );

    return { subscription, activeStudents, quotes, payments };
  }

  /** Start a hosted Paystack checkout for a tier; returns the pay URL. */
  async initCheckout(
    p: Principal,
    input: { plan: string; billingCycle: string },
  ): Promise<CheckoutInitResultDto> {
    // Fail fast (before any DB work) when the gateway is not configured.
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    if (!isPlan(input.plan)) throw new BadRequestException("plan must be STANDARD, PREMIUM, ULTIMATE or ENTERPRISE");
    if (!isBillingCycle(input.billingCycle)) throw new BadRequestException("billingCycle must be MONTH, TERM or YEAR");
    const plan: Plan = input.plan;
    const billingCycle: BillingCycle = input.billingCycle;

    // Charge with the same operator-effective pricing the overview quoted.
    const pricing = await this.planPricing.effective();
    const { email, amountMinor, seats, reference, paymentId } = await this.db.runAsTenant(
      this.ctx(p),
      async (tx) => {
        const seats = await this.activeStudents(tx);
        const amountMinor = computeSubscriptionPriceMinor(plan, seats, billingCycle, pricing);
        if (amountMinor <= 0) throw new BadRequestException("Nothing to charge for this plan");
        const reference = `SUB-${p.schoolId.slice(0, 8)}-${Date.now()}`;
        const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
        const payment = await tx.platformSubscriptionPayment.create({
          data: { schoolId: p.schoolId, plan, billingCycle, seats, amountMinor, reference, status: "PENDING", initiatedById: p.userId },
        });
        await this.audit.record(
          {
            actorId: p.userId,
            action: "billing.checkout.init",
            entity: "platform_subscription_payment",
            entityId: payment.id,
            schoolId: p.schoolId,
            metadata: { plan, billingCycle, seats, amountMinor },
          },
          tx,
        );
        return { email: user?.email ?? "billing@school", amountMinor, seats, reference, paymentId: payment.id };
      },
    );

    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor,
      reference,
      metadata: { kind: "subscription", schoolId: p.schoolId, paymentId, plan, billingCycle, seats },
    });
    return { authorizationUrl, reference };
  }

  /**
   * Verified-webhook handler (dispatched by PaystackService consumers when
   * metadata.kind === "subscription"). System context: keyed on the metadata's
   * schoolId, idempotent on the payment reference. Extends currentPeriodEnd.
   */
  async applySubscriptionPayment(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const md = event.data.metadata as { schoolId?: string } | undefined;
    const schoolId = md?.schoolId;
    const reference = event.data.reference;
    if (!schoolId || !reference) return { ok: true };

    const applied = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const payment = await tx.platformSubscriptionPayment.findFirst({ where: { reference } });
      if (!payment || payment.status === "PAID") return null; // unknown / already applied (idempotent)

      const plan: Plan = isPlan(payment.plan) ? payment.plan : DEFAULT_PLAN;
      const cycle: BillingCycle = isBillingCycle(payment.billingCycle) ? payment.billingCycle : BILLING_CYCLES.TERM;
      const now = new Date();

      const sub = await tx.schoolSubscription.findFirst({ where: { schoolId } });
      // Renewals stack: extend from the later of now / the current period end.
      const base = sub?.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
      const periodEnd = addMonths(base, CYCLE_MONTHS[cycle]);

      await tx.platformSubscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: now, periodStart: base, periodEnd },
      });

      const data = {
        plan,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        billingCycle: cycle,
        currentPeriodEnd: periodEnd,
        seats: payment.seats,
        priceMinor: payment.amountMinor,
      };
      if (sub) await tx.schoolSubscription.update({ where: { id: sub.id }, data });
      else await tx.schoolSubscription.create({ data: { schoolId, ...data } });

      await this.audit.record(
        {
          actorId: payment.initiatedById,
          action: "billing.subscription.paid",
          entity: "school_subscription",
          entityId: schoolId,
          schoolId,
          metadata: { plan, billingCycle: cycle, amountMinor: payment.amountMinor, reference, periodEnd },
        },
        tx,
      );
      return { plan, periodEnd, recipientId: payment.initiatedById };
    });

    if (!applied) return { ok: true };
    // New posture takes effect immediately (don't wait for the 30s cache TTL).
    this.entitlements.invalidate(schoolId);
    // Best-effort confirmation to the staff member who paid.
    try {
      await this.notifications.enqueue(
        { schoolId, userId: applied.recipientId },
        {
          recipientId: applied.recipientId,
          type: "BILLING",
          title: "Subscription active",
          body: `Your ${applied.plan} plan is active until ${applied.periodEnd.toDateString()}.`,
        },
      );
    } catch {
      // a notification failure must never undo a recorded payment
    }
    return { ok: true };
  }

  /** super_admin manual dunning sweep; audited in the operator's own tenant. */
  async runDunning(p: Principal): Promise<DunningResult> {
    const result = await this.dunning.sweep("MANUAL");
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "billing.dunning.run",
          entity: "school_subscription",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { ...result },
        },
        tx,
      ),
    );
    return result;
  }
}
