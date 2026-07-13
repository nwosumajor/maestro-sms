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
  CURRENCIES,
  CYCLE_MONTHS,
  DEFAULT_PLAN,
  PLANS,
  SUBSCRIPTION_STATUS,
  computeSubscriptionPriceMinor,
  defaultCurrencyFor,
  isBillingCycle,
  isCurrency,
  isPlan,
  planCurrencies,
  type BillingCycle,
  type BillingOverviewDto,
  type CheckoutInitResultDto,
  type Currency,
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
import { StripeService, type StripeEvent } from "../payments/stripe.service";
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
    private readonly stripe: StripeService,
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
    currency: string;
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
      currency: isCurrency(r.currency) ? r.currency : CURRENCIES.NGN,
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
    // Quote with the operator-effective pricing so the screen matches checkout —
    // one quote per (tier × cycle × ALLOWED currency); ENTERPRISE is USD-only.
    const pricing = await this.planPricing.effectiveAll();
    const quotes = SELLABLE_TIERS.flatMap((plan) =>
      planCurrencies(plan).flatMap((currency) =>
        QUOTE_CYCLES.map((cycle) => ({
          plan,
          billingCycle: cycle,
          seats: billableSeats,
          priceMinor: computeSubscriptionPriceMinor(plan, billableSeats, cycle, pricing[currency]),
          currency,
        })),
      ),
    );

    return { subscription, activeStudents, quotes, payments };
  }

  /** Start a hosted checkout for a tier — NGN pays via Paystack, USD via Stripe
   *  (ENTERPRISE is USD/Stripe only). Returns the gateway pay URL. */
  async initCheckout(
    p: Principal,
    input: { plan: string; billingCycle: string; currency?: string },
  ): Promise<CheckoutInitResultDto> {
    if (!isPlan(input.plan)) throw new BadRequestException("plan must be STANDARD, PREMIUM, ULTIMATE or ENTERPRISE");
    if (!isBillingCycle(input.billingCycle)) throw new BadRequestException("billingCycle must be MONTH, TERM or YEAR");
    const plan: Plan = input.plan;
    const billingCycle: BillingCycle = input.billingCycle;
    if (input.currency != null && !isCurrency(input.currency)) {
      throw new BadRequestException("currency must be NGN or USD");
    }
    // Safe cast: anything non-null was validated by isCurrency just above.
    const currency: Currency = (input.currency as Currency | undefined) ?? defaultCurrencyFor(plan);
    if (!planCurrencies(plan).includes(currency)) {
      throw new BadRequestException(`${plan} is billed in ${planCurrencies(plan).join("/")} only`);
    }
    // Fail fast (before any DB work) when the selected gateway is not configured.
    if (currency === CURRENCIES.NGN && !this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Naira payments are not configured");
    }
    if (currency === CURRENCIES.USD && !this.stripe.isConfigured()) {
      throw new ServiceUnavailableException("USD payments are not configured");
    }

    // Charge with the same operator-effective pricing the overview quoted.
    const pricing = await this.planPricing.effective(currency);
    const { email, amountMinor, seats, reference, paymentId } = await this.db.runAsTenant(
      this.ctx(p),
      async (tx) => {
        const seats = await this.activeStudents(tx);
        const amountMinor = computeSubscriptionPriceMinor(plan, seats, billingCycle, pricing);
        if (amountMinor <= 0) throw new BadRequestException("Nothing to charge for this plan");
        const reference = `SUB-${p.schoolId.slice(0, 8)}-${Date.now()}`;
        const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
        const payment = await tx.platformSubscriptionPayment.create({
          data: { schoolId: p.schoolId, plan, billingCycle, seats, amountMinor, currency, reference, status: "PENDING", initiatedById: p.userId },
        });
        await this.audit.record(
          {
            actorId: p.userId,
            action: "billing.checkout.init",
            entity: "platform_subscription_payment",
            entityId: payment.id,
            schoolId: p.schoolId,
            metadata: { plan, billingCycle, seats, amountMinor, currency },
          },
          tx,
        );
        return { email: user?.email ?? "billing@school", amountMinor, seats, reference, paymentId: payment.id };
      },
    );

    const metadata = { kind: "subscription", schoolId: p.schoolId, paymentId, plan, billingCycle, seats };
    const { authorizationUrl } =
      currency === CURRENCIES.USD
        ? await this.stripe.createCheckoutSession({
            email,
            amountMinor,
            reference,
            description: `SMS ${plan} plan — ${seats} students, ${billingCycle.toLowerCase()} billing`,
            metadata: { kind: "subscription", schoolId: p.schoolId, paymentId, reference },
          })
        : await this.paystack.initialize({ email, amountMinor, reference, metadata });
    return { authorizationUrl, reference };
  }

  /**
   * Verified PAYSTACK webhook (dispatched by consumers when metadata.kind ===
   * "subscription"). Idempotent on the payment reference.
   */
  async applySubscriptionPayment(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const md = event.data.metadata as { schoolId?: string } | undefined;
    return this.applyPaidByReference(md?.schoolId, event.data.reference, {
      amountMinor: event.data.amount,
      currency: event.data.currency,
    });
  }

  /**
   * Verified STRIPE webhook. A completed+paid Checkout Session with
   * metadata.kind === "subscription" applies exactly like a Paystack charge —
   * same core, same idempotency on the reference.
   */
  async applyStripeSubscriptionEvent(event: StripeEvent): Promise<{ ok: boolean }> {
    if (event.type !== "checkout.session.completed") return { ok: true };
    const session = event.data.object;
    if (session.payment_status !== "paid") return { ok: true };
    if (session.metadata?.kind !== "subscription") return { ok: true };
    const reference = session.client_reference_id ?? session.metadata?.reference;
    return this.applyPaidByReference(session.metadata?.schoolId, reference, {
      amountMinor: session.amount_total,
      currency: session.currency?.toUpperCase(),
    });
  }

  /**
   * Shared webhook core: flip the PENDING payment PAID and EXTEND the
   * subscription. System context keyed on the metadata's schoolId; idempotent on
   * the reference (a gateway retry can't double-extend).
   *
   * `paid` is the GATEWAY-reported settlement (amount in minor units + ISO
   * currency). SECURITY: defense in depth — sessions are created server-side at
   * our price, so these can't diverge in normal operation, but we still refuse
   * to activate on less than the quoted charge or on a different currency
   * (protects against gateway-dashboard misconfiguration or a future init path).
   * A mismatch marks the payment FAILED + audits it; the webhook still returns
   * ok so the gateway doesn't retry a permanently-wrong charge forever.
   */
  private async applyPaidByReference(
    schoolId: string | undefined,
    reference: string | undefined,
    paid?: { amountMinor?: number; currency?: string },
  ): Promise<{ ok: boolean }> {
    if (!schoolId || !reference) return { ok: true };

    const applied = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const payment = await tx.platformSubscriptionPayment.findFirst({ where: { reference } });
      if (!payment || payment.status === "PAID") return null; // unknown / already applied (idempotent)

      const underpaid = paid?.amountMinor != null && paid.amountMinor < payment.amountMinor;
      const wrongCurrency = paid?.currency != null && paid.currency.toUpperCase() !== payment.currency;
      if (underpaid || wrongCurrency) {
        await tx.platformSubscriptionPayment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        await this.audit.record(
          {
            actorId: payment.initiatedById,
            action: "billing.subscription.payment.mismatch",
            entity: "platform_subscription_payment",
            entityId: payment.id,
            schoolId,
            metadata: {
              reference,
              expectedMinor: payment.amountMinor,
              expectedCurrency: payment.currency,
              reportedMinor: paid?.amountMinor ?? null,
              reportedCurrency: paid?.currency ?? null,
            },
          },
          tx,
        );
        return null; // never extend the subscription on a mismatched settlement
      }

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
        currency: payment.currency,
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
          metadata: { plan, billingCycle: cycle, amountMinor: payment.amountMinor, currency: payment.currency, reference, periodEnd },
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
          body: `Your ${applied.plan} plan is active until ${applied.periodEnd.toDateString()}. This message is your payment receipt.`,
          channels: ["EMAIL"],
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
