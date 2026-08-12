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

import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, Optional} from "@nestjs/common";
import {
  BILLING_CYCLES,
  CURRENCIES,
  CYCLE_MONTHS,
  DEFAULT_PLAN,
  MAX_CHARGE_MINOR,
  MIN_CHARGE_MINOR,
  PLANS,
  LEGAL_DOCS_VERSION,
  SUBSCRIPTION_PAYMENT_KINDS,
  SUBSCRIPTION_STATUS,
  billedMonths,
  computeSubscriptionPriceMinor,
  formatMoney,
  normalisePeriods,
  computeTrueUpMinor,
  defaultCurrencyFor,
  isBillingCycle,
  isCurrency,
  isPlan,
  planCurrencies,
  prorationCreditMinor,
  type BillingCycle,
  type BillingOverviewDto,
  type CheckoutInitResultDto,
  type Currency,
  type Plan,
  type PlatformPaymentDto,
  type SubscriptionDto,
  PAYMENT_CHANNELS,
  pickCardRail,
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
import { countOnRollStudents } from "../common/student-scope";
import { ReferralService, type ReferralGrant } from "./referral.service";
import { encryptField } from "../foundation/field-crypto";
import PDFDocument from "pdfkit";
import { GrowthService } from "./growth.service";
import { PaymentChannelService } from "../payments/payment-channel.service";
import { toMinor, toMinorOrNull } from "../common/money";

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
  private readonly logger = new Logger("Billing");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly notifications: NotificationService,
    private readonly paystack: PaystackService,
    private readonly stripe: StripeService,
    private readonly dunning: BillingDunningService,
    private readonly planPricing: PlanPricingService,
    private readonly referrals: ReferralService,
    private readonly growth: GrowthService,
    // LAST and @Optional deliberately. DI always provides it in the running
    // app; being optional keeps every existing unit wiring compiling, and
    // absent it FAILS OPEN — a missing switchboard must never be the reason a
    // parent cannot pay. It gates a commercial choice, not a security boundary.
    @Optional() private readonly channels?: PaymentChannelService,
  ) {}

  /**
   * The gateway call failed, so the intent is VOID.
   *
   * The payment row is deliberately written BEFORE the gateway is called — an
   * arriving webhook needs something to match, the same intent-first pattern as
   * MobileMoneyIntent. But nothing undid it when the gateway then refused, so a
   * refused checkout left a PENDING row in the school's payment history for
   * ever. PENDING reads as "your money is on its way", which is the one thing
   * it definitely is not: there was never a charge.
   *
   * Marked FAILED rather than deleted — this table is an append-only financial
   * record. Best-effort: the caller is already throwing the real error, and
   * losing that error to a bookkeeping failure would be worse.
   */
  private async voidIntent(schoolId: string, paymentId: string, reason: string): Promise<void> {
    try {
      await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, (tx) =>
        tx.platformSubscriptionPayment.updateMany({
          where: { id: paymentId, status: "PENDING" },
          data: { status: "FAILED" },
        }),
      );
      this.logger.warn(`voided subscription intent ${paymentId}: ${reason}`);
    } catch (e) {
      this.logger.warn(`could not void subscription intent ${paymentId}: ${(e as Error).message}`);
    }
  }

  /**
   * A downloadable receipt for a subscription payment the school made.
   *
   * Parent fee payments have produced numbered receipt PDFs for a long time.
   * The school's own purchase — the larger transaction of the two, and the one
   * a bursar has to file against a budget — produced only an in-app
   * notification whose body said "this message is your payment receipt". That
   * is not a document anybody can attach to an expense claim.
   *
   * PAID rows only. There is no such thing as a receipt for money that was
   * never received, and issuing one for a PENDING or ABANDONED intent would
   * hand a school proof of a payment the platform never took.
   *
   * 404 for anything else, never 403 — the same posture as the fees receipt.
   */
  async receiptPdf(p: Principal, paymentId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const pay = await tx.platformSubscriptionPayment.findFirst({
        where: { id: paymentId, status: "PAID" },
      });
      if (!pay) throw new NotFoundException("Payment not found");
      const school = await tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "billing.receipt.download",
          entity: "platform_subscription_payment",
          entityId: paymentId,
          schoolId: p.schoolId,
        },
        tx,
      );
      return { pay, schoolName: school?.name ?? "" };
    });

    const { pay } = data;
    const issuedAt = pay.paidAt ?? pay.createdAt;
    const receiptNo = `SUB-${issuedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${paymentId.slice(0, 8).toUpperCase()}`;
    // formatMoney, never minor/100 — a zero-decimal currency prints at a
    // hundredth of its value under a naive divide, on the one page a payer reads.
    const amount = formatMoney(toMinor(pay.amountMinor), pay.currency);

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: "A5", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(16).text("MAESTRO-SMS", { align: "center" });
      doc.moveDown(0.3).fontSize(12).text("SUBSCRIPTION RECEIPT", { align: "center" });
      doc.moveDown();
      doc.fontSize(10);
      doc.text(`Receipt no: ${receiptNo}`);
      doc.text(`Date: ${issuedAt.toISOString().slice(0, 10)}`);
      doc.text(`School: ${data.schoolName}`);
      doc.moveDown();
      doc.text(`Plan: ${pay.plan}`);
      doc.text(`Billing cycle: ${pay.billingCycle}`);
      doc.text(`Seats billed: ${pay.seats}`);
      if (pay.periodStart && pay.periodEnd) {
        doc.text(
          `Period: ${pay.periodStart.toISOString().slice(0, 10)} to ${pay.periodEnd.toISOString().slice(0, 10)}`,
        );
      }
      doc.moveDown();
      doc.fontSize(12).text(`Amount paid: ${amount}`);
      doc.fontSize(10).text(`Gateway reference: ${pay.reference}`);
      doc.moveDown(2).fontSize(8).fillColor("#666")
        .text("Computer-generated receipt — valid without signature.", { align: "center" });
      doc.end();
    });
    return { buffer, filename: `${receiptNo}.pdf` };
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /**
   * Active students = distinct users holding the `student` role in this school.
   *
   * A COUNT, not a fetch-and-length. This hydrated one object per student
   * through the ORM purely to read `rows.length`, and it is not a cold path:
   * it runs on the billing screen, on every checkout, on the true-up quote and
   * on the seat top-up — and it is the number the school is BILLED on, so it
   * scales with exactly the thing that makes a customer valuable.
   *
   * Counting `user` rather than `userRole` keeps the distinct-users semantics in
   * SQL, where a duplicate role assignment cannot inflate a school's bill.
   */
  private async activeStudents(tx: TenantTx): Promise<number> {
    // ON ROLL, not "ever enrolled". This is the number a school is BILLED on;
    // counting pupils who have left charges them for children who are gone.
    return countOnRollStudents(tx);
  }

  private toPaymentDto(r: {
    id: string;
    reference: string;
    plan: string;
    billingCycle: string;
    seats: number;
    amountMinor: bigint | number;
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
      amountMinor: toMinor(r.amountMinor),
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

    const { activeStudents, payments, autoRenew, cardLast4, subRow } = await this.db.runAsTenant(
      this.ctx(p),
      async (tx) => {
        const seats = await this.activeStudents(tx);
        const rows = await tx.platformSubscriptionPayment.findMany({
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        const sub = await tx.schoolSubscription.findFirst({ where: { schoolId: p.schoolId } });
        return {
          activeStudents: seats,
          payments: rows.map((r) => this.toPaymentDto(r)),
          autoRenew: sub?.autoRenew ?? false,
          // A saved card exists only after a successful charge; last4 is display-only.
          cardLast4: sub?.paystackAuthorizationEnc ? (sub.cardLast4 ?? "····") : null,
          subRow: sub,
        };
      },
    );

    // Mid-cycle expansion economics, quoted with the SAME rules checkout charges:
    // the plan-change credit (unused time on the last payment) and the seat
    // true-up (extra students since the last charge, prorated to time left).
    const now = new Date();
    const subCycle: BillingCycle =
      subRow && isBillingCycle(subRow.billingCycle) ? subRow.billingCycle : BILLING_CYCLES.TERM;
    const planChangeCreditMinor =
      subRow && subRow.status === SUBSCRIPTION_STATUS.ACTIVE
        ? prorationCreditMinor(toMinor(subRow.priceMinor), subCycle, subRow.currentPeriodEnd, now)
        : 0;
    const subCurrency: Currency = subRow && isCurrency(subRow.currency ?? "") ? (subRow.currency as Currency) : CURRENCIES.NGN;
    const trueUp =
      subRow && isPlan(subRow.plan) && subRow.status === SUBSCRIPTION_STATUS.ACTIVE
        ? computeTrueUpMinor(
            subRow.plan,
            subRow.seats,
            activeStudents,
            subCycle,
            subRow.currentPeriodEnd,
            now,
            await this.planPricing.effective(subCurrency),
          )
        : null;

    const billableSeats = Math.max(1, activeStudents);
    // Quote with the operator-effective pricing so the screen matches checkout —
    // one quote per (tier × cycle × ALLOWED currency).
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

    // Can each quoted currency actually be charged right now? Asked ONCE per
    // distinct currency, not per quote — the quote list is tiers x currencies x
    // cycles, and this reads the channel config behind a cache.
    const quoteCurrencies = [...new Set(quotes.map((q) => q.currency))];
    const currencyAvailability = await Promise.all(
      quoteCurrencies.map(async (currency) => ({
        currency,
        ...((await this.channels?.billingAvailabilityFor(currency)) ?? { available: true, reason: null }),
      })),
    );

    return {
      subscription,
      activeStudents,
      quotes,
      payments,
      autoRenew,
      cardLast4,
      planChangeCreditMinor,
      trueUp,
      seatArrearsMinor: Math.max(0, toMinor(subRow?.seatArrearsMinor)),
      currencyAvailability,
    };
  }

  /** Start a checkout for the seat TRUE-UP quoted on the overview: the extra
   *  students enrolled since the last charge, priced for the time left. Applies
   *  seats-only on settlement (the period does not move). */
  async initTrueUpCheckout(p: Principal): Promise<CheckoutInitResultDto> {
    const now = new Date();
    const prep = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sub = await tx.schoolSubscription.findFirst({ where: { schoolId: p.schoolId } });
      if (!sub || !isPlan(sub.plan) || sub.status !== SUBSCRIPTION_STATUS.ACTIVE) {
        throw new BadRequestException("Seat top-up needs an active paid subscription");
      }
      const seats = await this.activeStudents(tx);
      const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
      return { sub, seats, email: user?.email ?? "billing@school" };
    });
    const cycle: BillingCycle = isBillingCycle(prep.sub.billingCycle) ? prep.sub.billingCycle : BILLING_CYCLES.TERM;
    const currency: Currency = isCurrency(prep.sub.currency ?? "") ? (prep.sub.currency as Currency) : CURRENCIES.NGN;
    if (currency === CURRENCIES.NGN && !this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Naira payments are not configured");
    }
    // WHICH RAIL, given the currency AND what the operator has switched on.
    // ENTERPRISE is priced in USD, and Paystack settles USD too — so while
    // Stripe is off, a USD subscription routes to Paystack rather than being
    // refused. Without this an ENTERPRISE school could not pay at all. When
    // Stripe is switched on, USD returns to it automatically.
    //
    // INITIATION only — settlement paths deliberately skip the switchboard, so
    // money already taken on a rail still lands after that rail is turned off.
    const rail = pickCardRail(
      currency,
      (await this.channels?.enabled()) ?? [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE],
    );
    if (!rail) {
      throw new ServiceUnavailableException(
        `Online payment in ${currency} is not available yet — please contact support to arrange payment.`,
      );
    }
    if (rail === PAYMENT_CHANNELS.STRIPE && !this.stripe.isConfigured()) {
      throw new ServiceUnavailableException("USD payments are not configured");
    }
    // CAN THE ACCOUNT ACTUALLY SETTLE THIS CURRENCY? Picking a rail that
    // supports the currency is not the same as an ACCOUNT enabled for it: a
    // Paystack account without USD refuses with a 403 that reached the school
    // as "Payment provider error", after they had already re-authenticated.
    // Refused here, with a reason an operator can act on.
    const settleable = await this.channels?.billingAvailabilityFor(currency);
    if (settleable && !settleable.available) {
      throw new ServiceUnavailableException(
        `${currency} payments are not available yet. ${settleable.reason ?? ""}`.trim(),
      );
    }
    const quote = computeTrueUpMinor(
      prep.sub.plan as Plan,
      prep.sub.seats,
      prep.seats,
      cycle,
      prep.sub.currentPeriodEnd,
      now,
      await this.planPricing.effective(currency),
    );
    // The top-up settles BOTH sides of mid-period growth: the metered arrears
    // already accrued (past usage) plus forward coverage for the time left.
    // Near period end the forward quote may be null while arrears remain —
    // still chargeable when the arrears alone clear the gateway floor.
    const arrearsMinor = Math.max(0, toMinor(prep.sub.seatArrearsMinor));
    const amountMinor = (quote?.amountMinor ?? 0) + arrearsMinor;
    if (amountMinor < MIN_CHARGE_MINOR) throw new BadRequestException("No seat top-up is due right now");

    const reference = `SUB-${p.schoolId.slice(0, 8)}-${Date.now()}`;
    const paymentId = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const payment = await tx.platformSubscriptionPayment.create({
        data: {
          schoolId: p.schoolId,
          plan: prep.sub.plan,
          billingCycle: cycle,
          seats: prep.seats,
          amountMinor,
          currency,
          reference,
          status: "PENDING",
          kind: SUBSCRIPTION_PAYMENT_KINDS.TRUEUP,
          arrearsMinor,
          initiatedById: p.userId,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "billing.trueup.init",
          entity: "platform_subscription_payment",
          entityId: payment.id,
          schoolId: p.schoolId,
          metadata: {
            extraSeats: quote?.extraSeats ?? 0,
            forwardMinor: quote?.amountMinor ?? 0,
            seatArrearsMinor: arrearsMinor,
            amountMinor,
            currency,
            legalVersion: LEGAL_DOCS_VERSION,
          },
        },
        tx,
      );
      return payment.id;
    });

    // A gateway refusal must not leave a PENDING row claiming money is in flight.
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } =
        rail === PAYMENT_CHANNELS.STRIPE
        ? await this.stripe.createCheckoutSession({
            email: prep.email,
            amountMinor,
            reference,
            description: quote
              ? `SMS seat top-up — ${quote.extraSeats} additional students${arrearsMinor > 0 ? " + metered usage" : ""}`
              : "SMS metered seat usage settlement",
            metadata: { kind: "subscription", schoolId: p.schoolId, paymentId, reference },
          })
        : await this.paystack.initialize({
            email: prep.email,
            amountMinor,
            currency,
            reference,
            metadata: { kind: "subscription", schoolId: p.schoolId, paymentId, reference },
            callbackUrl: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/billing?verify=${encodeURIComponent(reference)}`,
          }));
    } catch (err) {
      await this.voidIntent(p.schoolId, paymentId, `Gateway refused: ${(err as Error).message}`);
      throw err;
    }
    return { authorizationUrl, reference };
  }

  /**
   * Opt in/out of saved-card auto-renew. Enabling requires a stored (reusable)
   * card authorization — captured automatically from a successful card payment.
   * billing.manage + step-up at the controller; audited.
   */
  async setAutoRenew(p: Principal, enabled: boolean): Promise<{ autoRenew: boolean; cardLast4: string | null }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sub = await tx.schoolSubscription.findFirst({ where: { schoolId: p.schoolId } });
      if (!sub) throw new BadRequestException("No subscription row — contact the platform operator");
      if (enabled && !sub.paystackAuthorizationEnc) {
        throw new BadRequestException(
          "No saved card yet — pay once by card from this page and auto-renew can then be enabled",
        );
      }
      await tx.schoolSubscription.update({ where: { id: sub.id }, data: { autoRenew: enabled } });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "billing.auto_renew.set",
          entity: "school_subscription",
          entityId: sub.id,
          schoolId: p.schoolId,
          metadata: { enabled },
        },
        tx,
      );
      return { autoRenew: enabled, cardLast4: sub.cardLast4 };
    });
  }

  /** Start a hosted checkout for a tier — NGN pays via Paystack, USD via Stripe
   *  (ENTERPRISE is USD/Stripe only). Returns the gateway pay URL. */
  async initCheckout(
    p: Principal,
    input: { plan: string; billingCycle: string; currency?: string; promoCode?: string; periods?: number },
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
    // Same rail choice as the subscription checkout above.
    const rail = pickCardRail(
      currency,
      (await this.channels?.enabled()) ?? [PAYMENT_CHANNELS.PAYSTACK, PAYMENT_CHANNELS.STRIPE],
    );
    if (!rail) {
      throw new ServiceUnavailableException(
        `Online payment in ${currency} is not available yet — please contact support to arrange payment.`,
      );
    }
    if (rail === PAYMENT_CHANNELS.STRIPE && !this.stripe.isConfigured()) {
      throw new ServiceUnavailableException("USD payments are not configured");
    }
    // CAN THE ACCOUNT ACTUALLY SETTLE THIS CURRENCY? Picking a rail that
    // supports the currency is not the same as an ACCOUNT enabled for it: a
    // Paystack account without USD refuses with a 403 that reached the school
    // as "Payment provider error", after they had already re-authenticated.
    // Refused here, with a reason an operator can act on.
    const settleable = await this.channels?.billingAvailabilityFor(currency);
    if (settleable && !settleable.available) {
      throw new ServiceUnavailableException(
        `${currency} payments are not available yet. ${settleable.reason ?? ""}`.trim(),
      );
    }

    // Charge with the same operator-effective pricing the overview quoted.
    const pricing = await this.planPricing.effective(currency);
    // Promo codes discount the FIRST paid charge only — validated up front so a
    // bad code fails loudly before any payment row exists.
    const promo = input.promoCode ? await this.growth.validatePromo(input.promoCode) : null;
    const { email, amountMinor, seats, reference, paymentId } = await this.db.runAsTenant(
      this.ctx(p),
      async (tx) => {
        if (promo) {
          const prior = await tx.platformSubscriptionPayment.findFirst({
            where: { schoolId: p.schoolId, status: "PAID" },
            select: { id: true },
          });
          if (prior) throw new BadRequestException("Promo codes apply to a school's first subscription payment only");
        }
        const seats = await this.activeStudents(tx);
        // N periods in ONE charge. Buying five years by paying five times raced
        // the same currentPeriodEnd — measured at four concurrent renewals
        // advancing the period by two. One charge cannot race itself.
        const periods = normalisePeriods(input.periods ?? 1);
        const listMinor = computeSubscriptionPriceMinor(plan, seats, billingCycle, pricing) * periods;
        const grossMinor = promo ? Math.round((listMinor * (100 - promo.percentOff)) / 100) : listMinor;
        if (grossMinor <= 0) throw new BadRequestException("Nothing to charge for this plan");

        // Mid-cycle PLAN CHANGE: credit the unused fraction of what was last
        // paid against this charge (floored at the gateway minimum), and mark
        // the payment UPGRADE so applying it RESTARTS the period from now —
        // stacking would compensate the old remainder twice. Same-plan buys
        // stay RENEWAL (extend). Credit only applies in the SAME currency the
        // last charge was made in (no cross-currency arithmetic).
        const sub = await tx.schoolSubscription.findFirst({ where: { schoolId: p.schoolId } });
        const isPlanChange = !!sub && sub.plan !== plan;
        const credit =
          isPlanChange && sub.status === SUBSCRIPTION_STATUS.ACTIVE && sub.currency === currency && isBillingCycle(sub.billingCycle)
            ? prorationCreditMinor(toMinor(sub.priceMinor), sub.billingCycle, sub.currentPeriodEnd, new Date())
            : 0;
        // Outstanding seat arrears (metered unbilled seat-days) ride the next
        // charge in the SAME currency — the guaranteed collection point.
        const arrearsCurrency = sub?.currency && isCurrency(sub.currency) ? sub.currency : CURRENCIES.NGN;
        const arrearsMinor = sub && arrearsCurrency === currency ? Math.max(0, toMinor(sub.seatArrearsMinor)) : 0;
        const amountMinor = Math.max(MIN_CHARGE_MINOR, grossMinor - credit) + arrearsMinor;
        // The ledger stores this in a 32-bit column. Refuse ABOVE the limit
        // with something a bursar can act on, rather than letting the driver
        // throw a 500 after they have already re-authenticated.
        if (amountMinor > MAX_CHARGE_MINOR) {
          throw new BadRequestException(
            `That is a single charge of ${formatMoney(amountMinor, currency)}, which is above the maximum we can ` +
              `process at once. Buy a shorter period (or fewer at a time) and repeat — periods stack, so you end ` +
              `up at the same date.`,
          );
        }
        const kind = isPlanChange ? SUBSCRIPTION_PAYMENT_KINDS.UPGRADE : SUBSCRIPTION_PAYMENT_KINDS.RENEWAL;

        const reference = `SUB-${p.schoolId.slice(0, 8)}-${Date.now()}`;
        const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
        const payment = await tx.platformSubscriptionPayment.create({
          data: {
            schoolId: p.schoolId,
            plan,
            billingCycle,
            seats,
            amountMinor,
            currency,
            reference,
            status: "PENDING",
            kind,
            promoCode: promo?.code ?? null,
            arrearsMinor,
            billingPeriods: periods,
            initiatedById: p.userId,
          },
        });
        await this.audit.record(
          {
            actorId: p.userId,
            action: "billing.checkout.init",
            entity: "platform_subscription_payment",
            entityId: payment.id,
            schoolId: p.schoolId,
            metadata: {
              plan,
              billingCycle,
              seats,
              grossMinor,
              prorationCreditMinor: credit,
              promoCode: promo?.code ?? null,
              promoPercentOff: promo?.percentOff ?? null,
              seatArrearsMinor: arrearsMinor,
              amountMinor,
              currency,
              kind,
              // Which legal-pack version governed this purchase (clickwrap trail).
              legalVersion: LEGAL_DOCS_VERSION,
            },
          },
          tx,
        );
        return { email: user?.email ?? "billing@school", amountMinor, seats, reference, paymentId: payment.id };
      },
    );

    const metadata = { kind: "subscription", schoolId: p.schoolId, paymentId, plan, billingCycle, seats };
    // A gateway refusal must not leave a PENDING row claiming money is in flight.
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } =
        rail === PAYMENT_CHANNELS.STRIPE
        ? await this.stripe.createCheckoutSession({
            email,
            amountMinor,
            reference,
            description: `SMS ${plan} plan — ${seats} students, ${billingCycle.toLowerCase()} billing`,
            metadata: { kind: "subscription", schoolId: p.schoolId, paymentId, reference },
          })
        : await this.paystack.initialize({
            email, amountMinor, currency, reference, metadata,
            // Bring the school BACK so the page can verify immediately, rather
            // than leaving the whole flow dependent on a webhook arriving.
            callbackUrl: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/billing?verify=${encodeURIComponent(reference)}`,
          }));
    } catch (err) {
      await this.voidIntent(p.schoolId, paymentId, `Gateway refused: ${(err as Error).message}`);
      throw err;
    }
    return { authorizationUrl, reference };
  }

  /**
   * Verified PAYSTACK webhook (dispatched by consumers when metadata.kind ===
   * "subscription"). Idempotent on the payment reference.
   */
  async applySubscriptionPayment(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const md = event.data.metadata as { schoolId?: string } | undefined;
    // A REUSABLE card authorization enables saved-card auto-renew: captured from
    // the school's own successful charge (never entered by hand), stored
    // field-encrypted on the subscription row.
    const auth =
      event.data.authorization?.reusable && event.data.authorization.authorization_code
        ? {
            code: event.data.authorization.authorization_code,
            last4: event.data.authorization.last4 ?? null,
            customerCode: event.data.customer?.customer_code ?? null,
          }
        : undefined;
    return this.applyPaidByReference(md?.schoolId, event.data.reference, {
      amountMinor: event.data.amount,
      currency: event.data.currency,
      auth,
    });
  }

  /**
   * Verified STRIPE webhook. A completed+paid Checkout Session with
   * metadata.kind === "subscription" applies exactly like a Paystack charge —
   * same core, same idempotency on the reference.
   */
  async applyStripeSubscriptionEvent(event: StripeEvent): Promise<{ ok: boolean }> {
    const session = event.data.object;
    if (session.metadata?.kind !== "subscription") return { ok: true };
    const reference = session.client_reference_id ?? session.metadata?.reference;

    // Async payment methods (e.g. bank debits) can FAIL after checkout completes:
    // mark the payment FAILED and tell the payer — never leave silence.
    if (event.type === "checkout.session.async_payment_failed") {
      return this.failByReference(session.metadata?.schoolId, reference, "Your payment did not complete");
    }
    if (event.type !== "checkout.session.completed") return { ok: true };
    if (session.payment_status !== "paid") return { ok: true };
    return this.applyPaidByReference(session.metadata?.schoolId, reference, {
      amountMinor: session.amount_total,
      currency: session.currency?.toUpperCase(),
    });
  }

  /** Mark a PENDING payment FAILED + notify the initiator (in-app + email). */
  private async failByReference(
    schoolId: string | undefined,
    reference: string | undefined,
    reason: string,
  ): Promise<{ ok: boolean }> {
    if (!schoolId || !reference) return { ok: true };
    const failed = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const payment = await tx.platformSubscriptionPayment.findFirst({ where: { reference } });
      if (!payment || payment.status !== "PENDING") return null;
      await tx.platformSubscriptionPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return { recipientId: payment.initiatedById, plan: payment.plan };
    });
    if (failed) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: failed.recipientId },
          {
            recipientId: failed.recipientId,
            type: "BILLING",
            title: "Payment failed",
            body: `${reason} (ref ${reference}). Your ${failed.plan} subscription was NOT extended and no changes were made — please try again from the Billing page.`,
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort
      }
    }
    return { ok: true };
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
  /**
   * VERIFY ON RETURN — the school is back from the gateway; settle now.
   *
   * Parent fee payments have had this for a long time: the checkout carries a
   * callback_url, the payer lands back on the invoice, and the page verifies
   * against the gateway there and then. The school's OWN subscription — the
   * larger transaction of the two — had NOTHING. It carried no callback_url at
   * all, so the flow depended entirely on the webhook arriving.
   *
   * When one does not (no public URL configured, a delivery failure, a gateway
   * hiccup), the school sees "Payment successful" on Paystack and then a
   * payment history still saying "Awaiting payment", with their plan unchanged.
   * The daily reconciliation sweep does fix it — but a school that has just
   * been charged should not have to wait a day to see it, and will reasonably
   * conclude the payment failed and try again.
   *
   * Scoped to the caller's OWN school, and settled through the same
   * applyPaidByReference the webhook uses — so it is idempotent, takes the same
   * row lock, and cannot double-extend a period if the webhook then arrives.
   */
  async verifyPayment(p: Principal, reference: string): Promise<{ settled: boolean; subscription: SubscriptionDto }> {
    const row = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.platformSubscriptionPayment.findFirst({
        where: { reference },
        select: { id: true, status: true, schoolId: true },
      }),
    );
    // RLS already confines the read, but 404 rather than leak whether a
    // reference exists in some other school.
    if (!row) throw new NotFoundException("Payment not found");

    if (row.status !== "PAID") {
      const verified = await this.paystack.verifyTransaction(reference);
      if (verified?.status === "success") {
        await this.applyPaidByReference(p.schoolId, reference, {
          amountMinor: verified.amountMinor,
          currency: verified.currency,
        });
      }
    }

    const after = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.platformSubscriptionPayment.findFirst({ where: { reference }, select: { status: true } }),
    );
    return { settled: after?.status === "PAID", subscription: await this.getStatus(p) };
  }

  /**
   * RECOVER a subscription charge the gateway took but whose webhook never
   * arrived. Called by the daily reconciliation sweep.
   *
   * The sweep already did this for parent fee invoices and filtered subscription
   * charges straight out, so the platform's OWN revenue had no recovery path at
   * all. The consequence was the worst ordering possible: the school is charged,
   * the payment row stays PENDING, currentPeriodEnd is never extended — and then
   * dunning flips them PAST_DUE and downgrades them to STANDARD. A school pays
   * for ENTERPRISE and gets demoted for it, with nothing anywhere connecting the
   * two.
   *
   * Idempotent by construction: it goes through the same applyPaidByReference
   * the webhook uses, which refuses a row already PAID. So a recovered charge
   * and a late webhook cannot both extend the period.
   */
  async recoverSubscriptionCharge(
    schoolId: string,
    reference: string,
    paid: { amountMinor?: number; currency?: string },
  ): Promise<boolean> {
    const before = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, (tx) =>
      tx.platformSubscriptionPayment.findFirst({ where: { reference }, select: { status: true } }),
    );
    if (!before || before.status === "PAID") return false;
    await this.applyPaidByReference(schoolId, reference, paid);
    const after = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, (tx) =>
      tx.platformSubscriptionPayment.findFirst({ where: { reference }, select: { status: true } }),
    );
    return after?.status === "PAID";
  }

  private async applyPaidByReference(
    schoolId: string | undefined,
    reference: string | undefined,
    paid?: {
      amountMinor?: number;
      currency?: string;
      auth?: { code: string; last4: string | null; customerCode: string | null };
    },
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
        return { mismatch: { recipientId: payment.initiatedById, plan: payment.plan } };
      }

      const plan: Plan = isPlan(payment.plan) ? payment.plan : DEFAULT_PLAN;
      const cycle: BillingCycle = isBillingCycle(payment.billingCycle) ? payment.billingCycle : BILLING_CYCLES.TERM;
      const now = new Date();

      // SERIALISE THE PERIOD ARITHMETIC.
      //
      // Extending a subscription is a read-modify-write: read currentPeriodEnd,
      // add the cycle's months, write it back. Two webhooks arriving together —
      // a school buying several periods at once, a gateway retry racing the
      // original, or the reconciliation sweep racing a late webhook — each read
      // the SAME starting value and each wrote base + months, so the last write
      // won and the others vanished.
      //
      // Measured, not theorised: four concurrent RENEWAL webhooks all returned
      // 201, all four rows were marked PAID, and the period advanced 18 months
      // instead of 36. The school paid four times and got two, with nothing
      // anywhere reporting the discrepancy.
      //
      // The row lock makes the whole read-modify-write atomic per school, so
      // concurrent charges queue and stack instead of overwriting. Same pattern
      // the hostel allocator and the elimination ring already use. It locks ONE
      // school's row, so it cannot serialise unrelated tenants.
      await tx.$executeRaw`SELECT id FROM "school_subscription" WHERE "schoolId" = ${schoolId}::uuid FOR UPDATE`;
      const sub = await tx.schoolSubscription.findFirst({ where: { schoolId } });
      // How the payment applies (SUBSCRIPTION_PAYMENT_KINDS):
      //   RENEWAL — stack: extend from the later of now / current period end.
      //   UPGRADE — restart from now (the unused time was credited at checkout),
      //            but NEVER below the period already paid for — see below.
      //   TRUEUP  — seats only: the period does not move.
      const kind = payment.kind;
      const base =
        kind === SUBSCRIPTION_PAYMENT_KINDS.UPGRADE
          ? now
          : sub?.currentPeriodEnd && sub.currentPeriodEnd > now
            ? sub.currentPeriodEnd
            : now;
      // billedMonths is the ONE rule for "how long is this?" — the quote shown
      // before payment and the period written here both read it, so the screen
      // cannot promise a date settlement then disagrees with.
      const periods = normalisePeriods((payment as { billingPeriods?: number }).billingPeriods ?? 1);
      const computedEnd =
        kind === SUBSCRIPTION_PAYMENT_KINDS.TRUEUP && sub?.currentPeriodEnd
          ? sub.currentPeriodEnd
          : addMonths(base, billedMonths(cycle, periods));

      // A PAYMENT MUST NEVER SHORTEN A PERIOD THE SCHOOL HAS ALREADY PAID FOR.
      //
      // UPGRADE restarts from now, which is right for the FIRST upgrade — the
      // unused time on the old plan was credited in cash at checkout. It is
      // catastrophic for the second: observed on a real purchase, a school
      // bought five years (period correctly set to 2030-05-10) and a NGN 10,331
      // term charge settled 67 milliseconds later, also flagged UPGRADE because
      // it too had been started from the old plan. It restarted the period from
      // now and left them with three months. They paid NGN 241,912 for it.
      //
      // Whatever the kind, and whatever order the webhooks and the
      // reconciliation sweep happen to arrive in, taking the later of the two
      // dates makes the outcome order-independent and means no charge can ever
      // reduce access. The money side is already handled: proration credits the
      // unused time, so extending here does not give it away twice.
      const periodEnd =
        sub?.currentPeriodEnd && sub.currentPeriodEnd > computedEnd ? sub.currentPeriodEnd : computedEnd;

      await tx.platformSubscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: now, periodStart: kind === SUBSCRIPTION_PAYMENT_KINDS.TRUEUP ? now : base, periodEnd },
      });

      const data = {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        seats: payment.seats,
        // Settle the metered seat arrears this charge carried — decrement by
        // EXACTLY the snapshot (never blind-zeroing: the meter may have ticked
        // between checkout and webhook; the remainder stays owed).
        ...(payment.arrearsMinor > 0 && sub
          ? { seatArrearsMinor: Math.max(0, toMinor(sub.seatArrearsMinor) - toMinor(payment.arrearsMinor)) }
          : {}),
        // TRUEUP only tops seats up: plan/cycle/period/last-full-price stay —
        // overwriting priceMinor with the small top-up would corrupt the next
        // upgrade's proration credit.
        ...(kind === SUBSCRIPTION_PAYMENT_KINDS.TRUEUP
          ? {}
          : {
              plan,
              billingCycle: cycle,
              currentPeriodEnd: periodEnd,
              priceMinor: payment.amountMinor,
              currency: payment.currency,
            }),
        // Refresh the saved card on every successful charge (encrypted at rest)
        // so auto-renew always holds the most recent authorization.
        ...(paid?.auth
          ? {
              paystackAuthorizationEnc: encryptField(paid.auth.code, schoolId),
              cardLast4: paid.auth.last4,
              ...(paid.auth.customerCode ? { paystackCustomerCode: paid.auth.customerCode } : {}),
            }
          : {}),
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

      // Referral: a referred school's FIRST paid subscription rewards BOTH
      // sides one free term — granted atomically with this payment (both-sided
      // idempotency + the tenant-switch mechanics live in ReferralService).
      let referral: ReferralGrant | null = null;
      if (sub?.referredBySchoolId && !sub.referralRewardAt) {
        referral = await this.referrals.grantRewardsInTx(tx, {
          payingSchoolId: schoolId,
          subscriptionId: sub.id,
          referrerSchoolId: sub.referredBySchoolId,
          paidPeriodEnd: periodEnd,
          actorId: payment.initiatedById,
        });
      }
      return {
        plan,
        periodEnd: referral?.referredPeriodEnd ?? periodEnd,
        recipientId: payment.initiatedById,
        referral,
        // Post-commit growth hooks (privileged, best-effort): promo redemption
        // counts on settle; agent commission accrues once per school (DB-unique).
        promoCode: payment.promoCode,
        agentId: kind === SUBSCRIPTION_PAYMENT_KINDS.TRUEUP ? null : (sub?.agentId ?? null),
        chargedMinor: toMinor(payment.amountMinor),
        chargedCurrency: payment.currency,
      };
    });

    if (!applied) return { ok: true };
    // A mismatched settlement tells the payer it FAILED (never silence on money).
    const mismatch = (applied as { mismatch?: { recipientId: string; plan: string } }).mismatch;
    if (mismatch) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: mismatch.recipientId },
          {
            recipientId: mismatch.recipientId,
            type: "BILLING",
            title: "Payment failed",
            body:
              `Your ${mismatch.plan} subscription payment (ref ${reference}) could not be applied ` +
              `because the settled amount or currency did not match the quote. Your subscription was NOT ` +
              `extended — please contact the platform operator.`,
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort
      }
      return { ok: true };
    }
    // Narrow the success shape (the tx return is a union with the mismatch case).
    const ok = applied as {
      plan: Plan;
      periodEnd: Date;
      recipientId: string;
      referral: ReferralGrant | null;
      promoCode: string | null;
      agentId: string | null;
      chargedMinor: number;
      chargedCurrency: string;
    };
    // New posture takes effect immediately (don't wait for the 30s cache TTL).
    this.entitlements.invalidate(schoolId);
    if (ok.referral) this.entitlements.invalidate(ok.referral.referrerSchoolId);
    // Growth hooks — both best-effort and idempotent (a failure or retry can
    // never affect the recorded payment).
    if (ok.promoCode) await this.growth.redeemPromoOnSettle(ok.promoCode);
    if (ok.agentId) {
      await this.growth.accrueCommission({
        schoolId,
        agentId: ok.agentId,
        paymentRef: reference,
        chargedMinor: ok.chargedMinor,
        currency: ok.chargedCurrency,
      });
    }
    // Best-effort confirmation to the staff member who paid.
    try {
      const bonus = ok.referral
        ? ` Referral bonus applied: ${ok.referral.rewardMonths} extra months free (thanks to ${ok.referral.referrerSchoolName}).`
        : "";
      await this.notifications.enqueue(
        { schoolId, userId: ok.recipientId },
        {
          recipientId: ok.recipientId,
          type: "BILLING",
          title: "Subscription active",
          body: `Your ${ok.plan} plan is active until ${ok.periodEnd.toDateString()}.${bonus} This message is your payment receipt.`,
          channels: ["EMAIL"],
        },
      );
    } catch {
      // a notification failure must never undo a recorded payment
    }
    // Best-effort reward notice to the REFERRER (the code's creator).
    if (ok.referral?.referrerRecipientId) {
      try {
        await this.notifications.enqueue(
          { schoolId: ok.referral.referrerSchoolId, userId: ok.referral.referrerRecipientId },
          {
            recipientId: ok.referral.referrerRecipientId,
            type: "BILLING",
            title: "Referral reward earned",
            body:
              `${ok.referral.referredSchoolName} subscribed using your referral code — ` +
              `your school earned ${ok.referral.rewardMonths} months of free platform usage. ` +
              `Your subscription now runs until ${ok.referral.referrerPeriodEnd.toDateString()}.`,
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort
      }
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
