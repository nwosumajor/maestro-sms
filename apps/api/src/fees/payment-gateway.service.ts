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
import type { SettlementAccountDto } from "@sms/types";
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

@Injectable()
export class PaymentGatewayService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly billing: BillingService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Start a hosted Paystack checkout for the invoice's outstanding balance. */
  async initInvoicePayment(p: Principal, invoiceId: string) {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const { email, amountMinor, reference, subaccount } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
        select: { paystackSubaccountCode: true },
      });
      return {
        email: user?.email ?? "payer@school",
        amountMinor: balance,
        reference: `PAY-${invoiceId.slice(0, 8)}-${Date.now()}`,
        subaccount: school?.paystackSubaccountCode ?? undefined,
      };
    });

    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor,
      reference,
      metadata: { kind: "invoice", invoiceId, schoolId: p.schoolId },
      // Split settlement: money lands in the SCHOOL's bank; the school bears the
      // gateway fee on its own collections. Unset → legacy platform settlement.
      subaccount,
      bearer: "subaccount",
    });
    return { authorizationUrl, reference };
  }

  /** The school's fee-settlement posture (never the full account number). */
  async getSettlement(p: Principal): Promise<SettlementAccountDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const school = await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { paystackSubaccountCode: true, settlementBankCode: true, settlementBankName: true, settlementAccountLast4: true },
      });
      return {
        configured: !!school?.paystackSubaccountCode,
        bankCode: school?.settlementBankCode ?? null,
        bankName: school?.settlementBankName ?? null,
        accountLast4: school?.settlementAccountLast4 ?? null,
        subaccountCode: school?.paystackSubaccountCode ?? null,
      };
    });
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
    const kind = (event.data.metadata as { kind?: string } | undefined)?.kind;
    if (kind === "subscription") return this.billing.applySubscriptionPayment(event);
    if (event.event !== "charge.success") return { ok: true };
    return this.handleInvoiceCharge(event);
  }

  /** On charge.success for an invoice, post the payment + advance the status. */
  private async handleInvoiceCharge(event: PaystackEvent): Promise<{ ok: boolean }> {
    const { invoiceId, schoolId } = (event.data.metadata ?? {}) as { invoiceId?: string; schoolId?: string };
    if (!invoiceId || !schoolId) return { ok: true };

    // System-context write (no user): the actor is the invoice's creator.
    await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!inv) return;
      // IDEMPOTENCY: Paystack RETRIES a webhook on any non-2xx / timeout (and can
      // double-deliver). Without this guard each retry would insert ANOTHER POSTED
      // payment for the same gateway reference and double-credit the invoice. The
      // gateway reference is unique per charge, so it's the dedup key.
      const already = await tx.payment.findFirst({
        where: { invoiceId, reference: event.data.reference },
        select: { id: true },
      });
      if (already) return;
      await tx.payment.create({
        data: {
          schoolId,
          invoiceId,
          amountMinor: event.data.amount,
          method: "CARD",
          kind: "PAYMENT",
          status: "POSTED",
          reference: event.data.reference,
          note: "Online (Paystack)",
          recordedById: inv.createdById,
        },
      });
      const posted = await tx.payment.findMany({ where: { invoiceId, status: "POSTED" }, select: { amountMinor: true, kind: true } });
      const paid = posted.reduce((n: number, x: { amountMinor: number; kind: string }) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor), 0);
      const status = paid >= inv.totalMinor ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
      await this.audit.record(
        { actorId: inv.createdById, action: "fee.payment.online", entity: "invoice", entityId: invoiceId, schoolId, metadata: { reference: event.data.reference } },
        tx,
      );
    });
    return { ok: true };
  }

  private async canPay(tx: import("../integrity/integrity.foundation").TenantTx, p: Principal, studentId: string): Promise<boolean> {
    if (p.userId === studentId) return true;
    const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
    if (link) return true;
    return p.roles.some((r) => ["accountant", "school_admin", "principal", "super_admin"].includes(r));
  }
}
