// =============================================================================
// PaymentGatewayService — online card payments via Paystack (parent -> school)
// =============================================================================
// initInvoicePayment starts a Paystack transaction for an invoice's balance and
// returns the hosted checkout URL. The single account-wide webhook is verified by
// PaystackService and dispatched HERE by `metadata.kind`: "subscription" events
// go to BillingService (school -> platform); everything else is an invoice
// charge. Requires PAYSTACK_SECRET_KEY + outbound network; UNSET => the feature is
// gracefully disabled (503 / no-op), never a crash.
//
// NOTE: not live-testable in an offline sandbox (it calls api.paystack.co); the
// disabled path and signature verification are testable.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PLATFORM_FEE_BEARERS, computePlatformFeeMinor, isPlatformFeeBearer } from "@sms/types";
import type { InvoicePayInitDto, PlatformFeeBearer, SettlementAccountDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { BillingService } from "../billing/billing.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { PlatformFeeService } from "../billing/platform-fee.service";
import { AdmissionsService } from "../admissions/admissions.service";
import { MessageCreditsService } from "../notifications/message-credits.service";
import { DisputesService } from "./disputes.service";
import { GatewayEventService } from "../payments/gateway-event.service";
import { InvoiceSettlementService } from "./settlement.service";

@Injectable()
export class PaymentGatewayService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly billing: BillingService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly platformFees: PlatformFeeService,
    private readonly admissions: AdmissionsService,
    private readonly messageCredits: MessageCreditsService,
    private readonly disputes: DisputesService,
    private readonly gatewayEvents: GatewayEventService,
    private readonly settlement: InvoiceSettlementService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Start a hosted Paystack checkout for the invoice's outstanding balance,
   *  plus the platform's convenience fee when one is configured (take-rate). */
  async initInvoicePayment(p: Principal, invoiceId: string): Promise<InvoicePayInitDto> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const { email, balance, reference, subaccount, feeBearerOverride } = await this.db.runAsTenant(
      this.ctx(p),
      async (tx) => {
        const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
        if (!inv) throw new ForbiddenException("Invoice not found");
        // Payer must be able to see this invoice (their child's / own).
        const visible = await this.canPay(tx, p, inv.studentId);
        if (!visible) throw new ForbiddenException("Not your invoice");
        const posted = await tx.payment.findMany({ where: { invoiceId, status: "POSTED" }, select: { amountMinor: true, kind: true } });
        const paid = posted.reduce((n: number, x: { amountMinor: number; kind: string }) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor), 0);
        const balance = inv.totalMinor - paid;
        if (balance <= 0) throw new ForbiddenException("Nothing to pay");
        const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
        // The school's settlement subaccount (global registry, readable in-tenant):
        // when configured, this charge SPLITS to the school's own bank.
        const school = await tx.school.findFirst({
          where: { id: p.schoolId },
          select: { paystackSubaccountCode: true, paymentFeeBearer: true },
        });
        return {
          email: user?.email ?? "payer@school",
          balance,
          reference: `PAY-${invoiceId.slice(0, 8)}-${Date.now()}`,
          subaccount: school?.paystackSubaccountCode ?? undefined,
          feeBearerOverride: school?.paymentFeeBearer ?? null,
        };
      },
    );

    // Platform take-rate: applies ONLY on split settlements (with no subaccount
    // the whole charge already lands platform-side, so a fee is meaningless).
    // PARENT bearer: the card is charged invoice + fee and the school still nets
    // the invoice; SCHOOL bearer: the card is charged the invoice and the fee
    // comes out of the school's settlement. Either way the platform's cut is the
    // gateway split's transaction_charge — it never transits the school's bank.
    const cfg = await this.platformFees.effective();
    const feeMinor = subaccount ? computePlatformFeeMinor(balance, cfg) : 0;
    const bearer: PlatformFeeBearer =
      feeBearerOverride && isPlatformFeeBearer(feeBearerOverride) ? feeBearerOverride : cfg.bearer;
    const chargedMinor = bearer === PLATFORM_FEE_BEARERS.PARENT ? balance + feeMinor : balance;

    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor: chargedMinor,
      reference,
      // Verify-on-return: Paystack sends the payer back here with ?reference=…
      // and the invoice page confirms the charge against the gateway directly —
      // the payment posts even if the webhook never arrives (lost-webhook
      // recovery, layer 1; the reconciliation sweep is layer 2).
      callbackUrl: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/fees/${invoiceId}?verify=1`,
      // payerId: the signed-in user who clicked pay — the receipt goes to them
      // (plus the guardians and the student) when the webhook confirms.
      // invoiceAmountMinor/platformFeeMinor: the webhook credits the LEDGER with
      // the invoice amount only — the fee must never inflate the invoice credit.
      metadata: {
        kind: "invoice",
        invoiceId,
        schoolId: p.schoolId,
        payerId: p.userId,
        invoiceAmountMinor: balance,
        platformFeeMinor: feeMinor,
        feeBearer: bearer,
      },
      // Split settlement: money lands in the SCHOOL's bank; the school bears the
      // gateway fee on its own collections. Unset → legacy platform settlement.
      subaccount,
      bearer: "subaccount",
      transactionChargeMinor: feeMinor,
    });
    return { authorizationUrl, reference, invoiceAmountMinor: balance, feeMinor, chargedMinor };
  }

  /** The school's fee-settlement posture (never the full account number). */
  async getSettlement(p: Principal): Promise<SettlementAccountDto> {
    const cfg = await this.platformFees.effective();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: {
          paystackSubaccountCode: true,
          settlementBankCode: true,
          settlementBankName: true,
          settlementAccountLast4: true,
          paymentFeeBearer: true,
        },
      });
      return {
        configured: !!school?.paystackSubaccountCode,
        bankCode: school?.settlementBankCode ?? null,
        bankName: school?.settlementBankName ?? null,
        accountLast4: school?.settlementAccountLast4 ?? null,
        subaccountCode: school?.paystackSubaccountCode ?? null,
        feeBearer:
          school?.paymentFeeBearer && isPlatformFeeBearer(school.paymentFeeBearer) ? school.paymentFeeBearer : null,
        // A worked example (fee on ₦10,000) so the bearer choice is informed.
        sampleFeeMinor: computePlatformFeeMinor(1_000_000, cfg),
      };
    });
  }

  /**
   * The school chooses who bears the platform's convenience fee on ITS online
   * collections: PARENT (payer pays invoice + fee) or SCHOOL (fee comes out of
   * settlement). The school registry is global (app role SELECT-only), so the
   * write uses the PRIVILEGED client — same posture as setSettlement. Audited.
   */
  async setFeeBearer(p: Principal, bearer: string): Promise<SettlementAccountDto> {
    if (!isPlatformFeeBearer(bearer)) throw new BadRequestException("bearer must be PARENT or SCHOOL");
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Settlement management requires the privileged database configuration");
    }
    await client.school.update({ where: { id: p.schoolId }, data: { paymentFeeBearer: bearer } });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "fee.settlement.fee_bearer",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { bearer },
        },
        tx,
      ),
    );
    return this.getSettlement(p);
  }

  /**
   * Set the school's SETTLEMENT bank: creates a Paystack subaccount and stamps
   * its code on the school. From then on, every parent fee charge splits to the
   * school's own bank (platform keeps only PLATFORM_FEES_COMMISSION_PERCENT).
   * Money-critical: fee.manage + step-up at the controller; audited. The school
   * registry is global (app role SELECT-only), so the write uses the PRIVILEGED
   * client. Full account numbers are NEVER stored — only the last 4 digits.
   */
  async setSettlement(
    p: Principal,
    input: { bankCode: string; accountNumber: string },
  ): Promise<SettlementAccountDto> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Settlement management requires the privileged database configuration");
    }
    if (!/^\d{10}$/.test(input.accountNumber)) {
      throw new BadRequestException("accountNumber must be a 10-digit NUBAN");
    }
    const school = await client.school.findFirst({ where: { id: p.schoolId }, select: { name: true } });
    if (!school) throw new ServiceUnavailableException("School not found");

    const { subaccountCode, bankName } = await this.paystack.createSubaccount({
      businessName: school.name,
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
    });
    await client.school.update({
      where: { id: p.schoolId },
      data: {
        paystackSubaccountCode: subaccountCode,
        settlementBankCode: input.bankCode,
        settlementBankName: bankName,
        settlementAccountLast4: input.accountNumber.slice(-4),
      },
    });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "fee.settlement.set",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4), subaccountCode },
        },
        tx,
      ),
    );
    return this.getSettlement(p);
  }

  /**
   * Account-wide Paystack webhook. Verify once, then dispatch by metadata.kind:
   * "subscription" -> platform billing; otherwise an invoice charge.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ ok: boolean }> {
    const event = this.paystack.verify(rawBody, signature);
    if (!event) return { ok: true }; // disabled / nothing to do
    // Log EVERY verified event before dispatch (append-only evidence — even
    // events downstream drops). Best-effort; never blocks processing.
    const evtMeta = (event.data.metadata ?? event.data.transaction?.metadata ?? {}) as { schoolId?: string };
    await this.gatewayEvents.record({
      gateway: "PAYSTACK",
      eventType: event.event,
      reference: event.data.reference ?? event.data.transaction?.reference ?? null,
      schoolId: evtMeta.schoolId ?? null,
      payload: event,
    });
    // Dispute events first: their `data` is a DISPUTE (no metadata.kind) — the
    // tenant is resolved from the disputed transaction inside DisputesService.
    if (event.event.startsWith("charge.dispute.")) return this.disputes.applyDisputeEvent(event);
    const kind = (event.data.metadata as { kind?: string } | undefined)?.kind;
    if (kind === "subscription") return this.billing.applySubscriptionPayment(event);
    if (kind === "admission_form") return this.admissions.applyFormFeePayment(event);
    if (kind === "credits") return this.messageCredits.applyPurchase(event);
    if (event.event !== "charge.success") return { ok: true };
    return this.handleInvoiceCharge(event);
  }

  /** On charge.success for an invoice: extract the charge facts from OUR
   *  metadata and delegate to the shared, idempotent settlement path. */
  private async handleInvoiceCharge(event: PaystackEvent): Promise<{ ok: boolean }> {
    const { invoiceId, schoolId, payerId, invoiceAmountMinor, platformFeeMinor, feeBearer } = (event.data.metadata ??
      {}) as {
      invoiceId?: string;
      schoolId?: string;
      payerId?: string;
      invoiceAmountMinor?: number;
      platformFeeMinor?: number;
      feeBearer?: string;
    };
    if (!invoiceId || !schoolId) return { ok: true };
    // The LEDGER credit is the invoice amount, never the charged total: with a
    // parent-borne convenience fee the charge exceeds the invoice by the fee,
    // and crediting the full charge would silently overpay every invoice.
    // Back-compat: charges initialized before the fee existed carry no
    // invoiceAmountMinor — for those the charge IS the invoice amount.
    const creditMinor =
      typeof invoiceAmountMinor === "number" && invoiceAmountMinor > 0 ? invoiceAmountMinor : event.data.amount;
    const feeMinor = typeof platformFeeMinor === "number" && platformFeeMinor > 0 ? platformFeeMinor : 0;
    await this.settlement.applyOnlinePayment({
      schoolId,
      invoiceId,
      creditMinor,
      chargedMinor: event.data.amount,
      reference: event.data.reference,
      payerId,
      platformFeeMinor: feeMinor,
      note:
        feeMinor > 0
          ? `Online (Paystack) · platform fee ${feeBearer === "SCHOOL" ? "school-borne" : "payer-borne"}`
          : "Online (Paystack)",
    });
    return { ok: true };
  }

  /**
   * Verify-on-return (lost-webhook recovery, layer 1): the payer lands back on
   * the invoice page with ?reference=…, and we confirm the charge DIRECTLY
   * against the gateway — if it settled and the webhook never arrived, the
   * payment posts here, idempotently. The metadata must match the invoice the
   * caller is looking at AND the caller's own school (the reference is
   * payer-visible in the redirect URL; nothing here trusts it beyond using it
   * as a lookup key at the gateway).
   */
  async confirmInvoicePayment(
    p: Principal,
    invoiceId: string,
    reference: string,
  ): Promise<{ status: "posted" | "already_recorded" | "not_settled" }> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    // The caller must be able to see this invoice (payer/guardian/staff).
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { studentId: true } });
      if (!inv) throw new ForbiddenException("Invoice not found");
      if (!(await this.canPay(tx, p, inv.studentId))) throw new ForbiddenException("Not your invoice");
    });
    const verified = await this.paystack.verifyTransaction(reference);
    if (!verified || verified.status !== "success") return { status: "not_settled" };
    const meta = verified.metadata as {
      kind?: string;
      invoiceId?: string;
      schoolId?: string;
      payerId?: string;
      invoiceAmountMinor?: number;
      platformFeeMinor?: number;
    };
    // The gateway-confirmed charge must belong to THIS invoice in THIS school.
    if (meta.kind !== "invoice" || meta.invoiceId !== invoiceId || meta.schoolId !== p.schoolId) {
      return { status: "not_settled" };
    }
    const creditMinor =
      typeof meta.invoiceAmountMinor === "number" && meta.invoiceAmountMinor > 0
        ? meta.invoiceAmountMinor
        : verified.amountMinor;
    const outcome = await this.settlement.applyOnlinePayment({
      schoolId: p.schoolId,
      invoiceId,
      creditMinor,
      chargedMinor: verified.amountMinor,
      reference,
      payerId: meta.payerId ?? p.userId,
      platformFeeMinor: typeof meta.platformFeeMinor === "number" ? meta.platformFeeMinor : 0,
      note: "Online (Paystack) · confirmed on return",
    });
    return { status: outcome === "posted" ? "posted" : "already_recorded" };
  }

  private async canPay(tx: import("../integrity/integrity.foundation").TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (p.userId === studentId) return true;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return true;
    return p.roles.some((r) => ["accountant", "school_admin", "principal", "super_admin"].includes(r));
  }
}
