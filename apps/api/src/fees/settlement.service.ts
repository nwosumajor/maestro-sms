// =============================================================================
// InvoiceSettlementService — the ONE place an online invoice payment posts
// =============================================================================
// Extracted from the Paystack webhook handler so every settlement path shares
// one idempotent implementation: the account webhook, the payer's
// verify-on-return confirm, the reconciliation sweep, and (Stripe) the billing
// webhook's kind=invoice dispatch. Idempotent on the gateway reference — the
// dedup key that makes webhook retries, verify-after-webhook and reconcile-
// after-verify all safe to race. Posts the payment, advances the invoice
// status, audit-logs, receipts payer/guardians/student, and alerts finance on
// overpayment. Lives in its own module (imported by FeesModule and
// BillingModule; imports neither).
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { NotificationService } from "../notifications/notification.service";

export interface OnlinePaymentInput {
  schoolId: string;
  invoiceId: string;
  /** The LEDGER credit (invoice amount), in minor units — never the charged
   *  total when a payer-borne convenience fee inflated the charge. */
  creditMinor: number;
  /** What the card was actually charged (for the receipt line). */
  chargedMinor: number;
  /** Gateway reference — THE idempotency key. */
  reference: string;
  /** The signed-in user who initiated checkout, when known (gets the receipt). */
  payerId?: string;
  platformFeeMinor?: number;
  /** Free-text method note (e.g. 'Online (Paystack)'). */
  note: string;
  /** Ledger method — CARD for checkout charges (default), BANK_TRANSFER for
   *  dedicated-account (virtual NUBAN) credits. */
  method?: "CARD" | "BANK_TRANSFER";
}

export type SettlementOutcome = "posted" | "duplicate" | "invoice_missing";

@Injectable()
export class InvoiceSettlementService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  async applyOnlinePayment(input: OnlinePaymentInput): Promise<SettlementOutcome> {
    const { schoolId, invoiceId } = input;
    // System-context write (no user): the audit actor is the invoice's creator.
    const receipt = await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!inv) return "invoice_missing" as const;
      // IDEMPOTENCY: the gateway RETRIES a webhook on any non-2xx / timeout
      // (and can double-deliver), and verify-on-return / reconciliation can
      // race the webhook. Without this guard each path would insert ANOTHER
      // POSTED payment for the same charge and double-credit the invoice.
      const already = await tx.payment.findFirst({
        where: { invoiceId, reference: input.reference },
        select: { id: true },
      });
      if (already) return "duplicate" as const;
      await tx.payment.create({
        data: {
          schoolId,
          invoiceId,
          amountMinor: input.creditMinor,
          method: input.method ?? "CARD",
          kind: "PAYMENT",
          status: "POSTED",
          reference: input.reference,
          platformFeeMinor: input.platformFeeMinor ?? 0,
          note: input.note,
          recordedById: inv.createdById,
        },
      });
      const posted = await tx.payment.findMany({
        where: { invoiceId, status: "POSTED" },
        select: { amountMinor: true, kind: true },
      });
      const paid = posted.reduce(
        (n: number, x: { amountMinor: number; kind: string }) => n + (x.kind === "REFUND" ? -x.amountMinor : x.amountMinor),
        0,
      );
      const status = paid >= inv.totalMinor ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
      await this.audit.record(
        {
          actorId: inv.createdById,
          action: "fee.payment.online",
          entity: "invoice",
          entityId: invoiceId,
          schoolId,
          metadata: { reference: input.reference },
        },
        tx,
      );
      const guardians = await tx.parentChild.findMany({
        where: { studentId: inv.studentId },
        select: { parentId: true },
      });
      // OVERPAYMENT detection: two guardians can legitimately race to pay the
      // same invoice — both charges succeed at the gateway. The ledger records
      // it honestly; finance must be TOLD so the excess is refunded promptly.
      let financeRecipients: string[] = [];
      if (paid > inv.totalMinor) {
        const finance = await tx.userRole.findMany({
          where: { role: { name: { in: ["accountant", "school_admin"] } } },
          select: { userId: true },
          distinct: ["userId"],
        });
        financeRecipients = [...new Set([...finance.map((f: { userId: string }) => f.userId), inv.createdById])];
      }
      return {
        invoiceRef: inv.reference,
        currency: inv.currency,
        balanceAfter: inv.totalMinor - paid,
        overpaidMinor: Math.max(0, paid - inv.totalMinor),
        financeRecipients,
        recipients: [
          ...new Set([
            ...guardians.map((g: { parentId: string }) => g.parentId),
            inv.studentId,
            ...(input.payerId ? [input.payerId] : []),
          ]),
        ],
      };
    });

    if (receipt === "invoice_missing") return "invoice_missing";
    if (receipt === "duplicate") return "duplicate";

    // Receipt AFTER the committed write — a notification failure never undoes
    // a recorded payment. Every online payment gets one, partial or full.
    const fmt = (minor: number) =>
      new Intl.NumberFormat("en-NG", { style: "currency", currency: receipt.currency }).format(minor / 100);
    const balanceLine =
      receipt.balanceAfter <= 0
        ? "The invoice is now fully paid. Thank you."
        : `Outstanding balance: ${fmt(receipt.balanceAfter)}.`;
    for (const recipientId of receipt.recipients) {
      try {
        await this.notifications.enqueue(
          { schoolId, userId: recipientId },
          {
            recipientId,
            type: "PAYMENT_RECEIVED",
            title: "Payment receipt — successful",
            body: `We received ${fmt(input.chargedMinor)} by card on invoice ${receipt.invoiceRef} (ref ${input.reference}). ${balanceLine}`,
            data: { invoiceId, reference: input.reference, amountMinor: input.chargedMinor },
            channels: ["EMAIL"],
          },
        );
      } catch {
        // best-effort per recipient
      }
    }
    if (receipt.overpaidMinor > 0) {
      for (const recipientId of receipt.financeRecipients) {
        try {
          await this.notifications.enqueue(
            { schoolId, userId: recipientId },
            {
              recipientId,
              type: "BILLING",
              title: "Overpayment on an invoice — refund due",
              body: `Invoice ${receipt.invoiceRef} is overpaid by ${fmt(receipt.overpaidMinor)} (likely two payers paying at once, ref ${input.reference}). Record a refund of the excess from the invoice page.`,
              data: { invoiceId, overpaidMinor: receipt.overpaidMinor },
              channels: ["EMAIL"],
            },
          );
        } catch {
          // best-effort per recipient
        }
      }
    }
    return "posted";
  }
}
