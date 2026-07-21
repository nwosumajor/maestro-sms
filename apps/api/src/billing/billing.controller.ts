// =============================================================================
// BillingController — school self-serve subscription (ALWAYS-ON, no @RequireModule)
// =============================================================================
// Billing is orthogonal to the module-entitlement layer it sells, so it is never
// itself module-gated (like operator/auth/privacy). A school's principal/
// school_admin reads the overview and starts a checkout; checkout is step-up
// gated (money + a privilege change, consistent with maker-checker / impersonation).
// The Paystack webhook is NOT here — it stays on the single @Public fees route and
// is dispatched to BillingService by metadata.kind (Paystack allows one webhook URL).
// The STRIPE webhook (USD subscriptions) IS here: Stripe is used only for platform
// billing, so its endpoint lives with the billing surface. @Public + signature-
// verified against the raw body, mirroring the Paystack posture.
// =============================================================================

import { Body, Controller, Get, Headers, Post, Put, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { BILLING_CYCLES, CURRENCIES, BILLING_PERMISSIONS, PLANS } from "@sms/types";
import type { BillingOverviewDto, CheckoutInitResultDto, ReferralInfoDto } from "@sms/types";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { StripeService, type StripeEvent } from "../payments/stripe.service";
import { DisputesService } from "../fees/disputes.service";
import { GatewayEventService } from "../payments/gateway-event.service";
import { InvoiceSettlementService } from "../fees/settlement.service";
import { BillingService } from "./billing.service";
import { ReferralService } from "./referral.service";
import { MessageCreditsService } from "../notifications/message-credits.service";

const autoRenewSchema = z.object({ enabled: z.boolean() });
const creditsSchema = z.object({ bundleId: z.string().min(1).max(10) });

const checkoutSchema = z.object({
  plan: z.enum([PLANS.STANDARD, PLANS.PREMIUM, PLANS.ULTIMATE, PLANS.ENTERPRISE]),
  billingCycle: z.enum([BILLING_CYCLES.MONTH, BILLING_CYCLES.TERM, BILLING_CYCLES.YEAR]),
  // NGN → Paystack, USD → Stripe. Omitted → the tier's default (₦; $ for ENTERPRISE).
  currency: z.enum([CURRENCIES.NGN, CURRENCIES.USD]).optional(),
  // Operator-issued discount — first paid charge only, validated server-side.
  promoCode: z.string().max(30).optional(),
});

@Controller("billing")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly stripe: StripeService,
    private readonly referrals: ReferralService,
    private readonly messageCredits: MessageCreditsService,
    private readonly disputes: DisputesService,
    private readonly gatewayEvents: GatewayEventService,
    private readonly settlement: InvoiceSettlementService,
  ) {}

  /** The billing screen: current subscription + per-tier quotes + history. */
  @Get()
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  overview(@CurrentPrincipal() p: Principal): Promise<BillingOverviewDto> {
    return this.billing.getOverview(p);
  }

  /** Light subscription posture for the AppShell renewal banner (cheap: one
   *  cached entitlement resolution, no payments/quotes). */
  @Get("status")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  status(@CurrentPrincipal() p: Principal) {
    return this.billing.getStatus(p);
  }

  /** Start a hosted Paystack checkout for a tier. Step-up re-auth required. */
  @Post("checkout/init")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  @RequireStepUp()
  checkout(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ): Promise<CheckoutInitResultDto> {
    return this.billing.initCheckout(p, body);
  }

  /** Stripe webhook (USD subscription payments). Public: carries no session;
   *  authenticated by the Stripe-Signature HMAC over the RAW body. Disabled
   *  (no-op 200) when STRIPE_WEBHOOK_SECRET is unset. */
  @Public()
  @Post("stripe/webhook")
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string | undefined,
  ): Promise<{ ok: boolean }> {
    const event = this.stripe.verifyWebhook(req.rawBody, signature);
    if (!event) return { ok: true }; // gateway disabled / empty body
    // Log EVERY verified event before dispatch (append-only evidence).
    await this.gatewayEvents.record({
      gateway: "STRIPE",
      eventType: event.type,
      reference: event.data.object.client_reference_id ?? event.data.object.charge ?? event.data.object.id ?? null,
      schoolId: event.data.object.metadata?.schoolId ?? null,
      payload: event,
    });
    // Chargebacks route to the shared dispute ingestion (same table/alerts as
    // Paystack disputes); kind=invoice checkouts are USD FEE payments feeding
    // the shared invoice settlement; everything else is subscription settlement.
    if (event.type.startsWith("charge.dispute.")) return this.disputes.applyStripeDisputeEvent(event);
    const meta = (event.data.object.metadata ?? {}) as { kind?: string };
    if (meta.kind === "invoice") return this.applyStripeInvoicePayment(event);
    return this.billing.applyStripeSubscriptionEvent(event);
  }

  /** checkout.session.completed for a USD invoice: post through the shared,
   *  idempotent settlement path (same guarantees as the Paystack rail). */
  private async applyStripeInvoicePayment(event: StripeEvent): Promise<{ ok: boolean }> {
    if (event.type !== "checkout.session.completed") return { ok: true };
    const obj = event.data.object;
    if (obj.payment_status && obj.payment_status !== "paid") return { ok: true };
    const meta = (obj.metadata ?? {}) as {
      invoiceId?: string;
      schoolId?: string;
      payerId?: string;
      invoiceAmountMinor?: string;
    };
    const reference = obj.client_reference_id;
    if (!meta.invoiceId || !meta.schoolId || !reference) return { ok: true };
    const charged = obj.amount_total ?? Number(meta.invoiceAmountMinor ?? 0);
    const credit = Number(meta.invoiceAmountMinor ?? 0) > 0 ? Number(meta.invoiceAmountMinor) : charged;
    await this.settlement.applyOnlinePayment({
      schoolId: meta.schoolId,
      invoiceId: meta.invoiceId,
      creditMinor: credit,
      chargedMinor: charged,
      reference,
      payerId: meta.payerId,
      note: "Online (Stripe, USD)",
    });
    return { ok: true };
  }

  /** super_admin manual dunning sweep (the scheduled job runs daily). */
  @Post("dunning/run")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_DUNNING_RUN)
  dunning(@CurrentPrincipal() p: Principal) {
    return this.billing.runDunning(p);
  }

  /** The school's referral panel: shareable code + conversions earned. */
  @Get("referral")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  referral(@CurrentPrincipal() p: Principal): Promise<ReferralInfoDto> {
    return this.referrals.getMine(p);
  }

  /** Generate the school's referral code (idempotent; audited). */
  @Post("referral/code")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  createReferralCode(@CurrentPrincipal() p: Principal): Promise<ReferralInfoDto> {
    return this.referrals.ensureCode(p);
  }

  /** Start a checkout for the seat true-up quoted on the overview. */
  @Post("true-up/init")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  @RequireStepUp()
  trueUp(@CurrentPrincipal() p: Principal): Promise<CheckoutInitResultDto> {
    return this.billing.initTrueUpCheckout(p);
  }

  /** Message-credit balance + purchasable bundles (SMS/WhatsApp metering). */
  @Get("credits")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  credits(@CurrentPrincipal() p: Principal) {
    return this.messageCredits.overview(p);
  }

  /** Buy a message-credit bundle (hosted Paystack checkout). */
  @Post("credits/checkout")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  @RequireStepUp()
  buyCredits(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(creditsSchema)) body: z.infer<typeof creditsSchema>,
  ) {
    return this.messageCredits.initPurchase(p, body.bundleId);
  }

  /** Opt in/out of saved-card auto-renew. Step-up: it arms future charges. */
  @Put("auto-renew")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  @RequireStepUp()
  setAutoRenew(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(autoRenewSchema)) body: z.infer<typeof autoRenewSchema>,
  ) {
    return this.billing.setAutoRenew(p, body.enabled);
  }
}
