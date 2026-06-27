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

import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { BillingService } from "../billing/billing.service";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";

@Injectable()
export class PaymentGatewayService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly billing: BillingService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Start a hosted Paystack checkout for the invoice's outstanding balance. */
  async initInvoicePayment(p: Principal, invoiceId: string) {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const { email, amountMinor, reference } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
      return { email: user?.email ?? "payer@school", amountMinor: balance, reference: `PAY-${invoiceId.slice(0, 8)}-${Date.now()}` };
    });

    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor,
      reference,
      metadata: { kind: "invoice", invoiceId, schoolId: p.schoolId },
    });
    return { authorizationUrl, reference };
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
    await this.db.runAsTenant({ schoolId, userId: "00000000-0000-0000-0000-000000000000" }, async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!inv) return;
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
