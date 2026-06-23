// =============================================================================
// PaymentGatewayService — online card payments via Paystack (no SDK; fetch)
// =============================================================================
// initInvoicePayment starts a Paystack transaction for an invoice's balance and
// returns the hosted checkout URL. The webhook (HMAC-SHA512 verified) records a
// POSTED payment on charge.success. Requires PAYSTACK_SECRET_KEY + outbound
// network; UNSET => the feature is gracefully disabled (503), never a crash.
//
// NOTE: not live-testable in an offline sandbox (it calls api.paystack.co); the
// disabled path and signature verification are testable.
// =============================================================================

import { ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const PAYSTACK = "https://api.paystack.co";

@Injectable()
export class PaymentGatewayService {
  private readonly logger = new Logger("PaymentGateway");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private secret(): string {
    const s = process.env.PAYSTACK_SECRET_KEY;
    if (!s) throw new ServiceUnavailableException("Online payments are not configured");
    return s;
  }

  /** Start a hosted Paystack checkout for the invoice's outstanding balance. */
  async initInvoicePayment(p: Principal, invoiceId: string) {
    const secret = this.secret();
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

    const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, amount: amountMinor, reference, metadata: { invoiceId, schoolId: p.schoolId } }),
    });
    if (!res.ok) {
      this.logger.error(`Paystack init failed: ${res.status}`);
      throw new ServiceUnavailableException("Payment provider error");
    }
    const json = (await res.json()) as { data: { authorization_url: string } };
    return { authorizationUrl: json.data.authorization_url, reference };
  }

  /** Verified Paystack webhook. On charge.success, post the payment. */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ ok: boolean }> {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret || !rawBody) return { ok: true }; // disabled / nothing to do
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    if (!signature || hash !== signature) throw new UnauthorizedException("Bad signature");

    const event = JSON.parse(rawBody.toString("utf8")) as {
      event: string;
      data: { amount: number; reference: string; metadata?: { invoiceId?: string; schoolId?: string } };
    };
    if (event.event !== "charge.success") return { ok: true };
    const { invoiceId, schoolId } = event.data.metadata ?? {};
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
