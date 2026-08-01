// =============================================================================
// PaymentReconciliationService — lost-webhook recovery, layer 2 (the sweep)
// =============================================================================
// Verify-on-return (layer 1) only helps when the payer comes back to the site.
// This sweep closes the remaining hole: it lists the gateway's SUCCESSFUL
// transactions for the last RECONCILE_WINDOW_DAYS, and any invoice charge with
// no matching POSTED payment in our ledger is posted through the shared,
// idempotent settlement path — so a webhook outage can delay a credit by at
// most one sweep, never lose it. Cross-tenant by nature (the gateway account
// is platform-wide), so the ledger check uses the PRIVILEGED client — the same
// deliberate posture as the dunning sweep; the actual posting goes through the
// ordinary tenant path (RLS intact) per school. Daily BullMQ job + a manual
// super_admin trigger; cleanly disabled (503 / no-op) without gateway creds or
// a privileged URL.
// =============================================================================

import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PaystackService } from "../payments/paystack.service";
import { StripeService } from "../payments/stripe.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { InvoiceSettlementService } from "./settlement.service";

export const FEE_RECONCILE_QUEUE = "fee-reconcile";
export const FEE_RECONCILE_JOB = "fee-reconcile-sweep";
export const FEE_RECONCILE_SCHEDULER_ID = "fee-reconcile-daily";
/** 04:10 daily — after the gateway's own settlement runs, before school hours. */
export const DEFAULT_RECONCILE_CRON = "10 4 * * *";
/** How far back each sweep looks. Overlapping windows are safe: settlement is
 *  idempotent on the reference. */
export const RECONCILE_WINDOW_DAYS = 3;

export interface ReconcileResult {
  scanned: number;
  invoiceCharges: number;
  missing: number;
  posted: number;
}

/** Gateway metadata, normalised across Paystack (numeric) and Stripe (string). */
interface CandidateMeta {
  kind?: string;
  invoiceId?: string;
  schoolId?: string;
  payerId?: string;
  invoiceAmountMinor?: number | string;
  platformFeeMinor?: number | string;
}

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger("Reconcile");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly stripe: StripeService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly settlement: InvoiceSettlementService,
  ) {}

  /** Manual trigger (fee.reconcile.run — super_admin). Audited to the caller. */
  async runManual(p: Principal): Promise<ReconcileResult> {
    if (!this.paystack.isConfigured() && !this.stripe.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    if (!this.privileged.client) {
      throw new ServiceUnavailableException("Reconciliation requires the privileged database configuration");
    }
    const result = await this.sweep("MANUAL");
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "fee.reconcile.run",
          entity: "gateway",
          entityId: "paystack",
          schoolId: p.schoolId,
          metadata: { ...result },
        },
        tx,
      ),
    );
    return result;
  }

  async sweep(trigger: "SCHEDULED" | "MANUAL"): Promise<ReconcileResult> {
    const zero: ReconcileResult = { scanned: 0, invoiceCharges: 0, missing: 0, posted: 0 };
    const client = this.privileged.client;
    if ((!this.paystack.isConfigured() && !this.stripe.isConfigured()) || !client) {
      if (trigger === "SCHEDULED") this.logger.log("reconcile skipped (no gateway or privileged client)");
      return zero;
    }
    const from = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 86_400_000);

    // Gather settled charges from BOTH gateways — one list call each. Each
    // candidate CARRIES ITS OWN CURRENCY: Paystack settles five (NGN/GHS/ZAR/
    // KES/USD), so "Paystack means NGN" stopped being true the moment schools
    // outside Nigeria went live. Settlement checks it against the invoice and
    // refuses a mismatch rather than crediting the wrong number.
    type Candidate = { reference: string; amountMinor: number; currency: string; note: string; meta: CandidateMeta };
    const candidates: Candidate[] = [];
    if (this.paystack.isConfigured()) {
      const txs = await this.paystack.listSuccessfulTransactions(from);
      for (const t of txs)
        candidates.push({
          reference: t.reference,
          amountMinor: t.amountMinor,
          currency: t.currency,
          note: "Online (Paystack) · recovered by reconciliation",
          meta: t.metadata as CandidateMeta,
        });
    }
    if (this.stripe.isConfigured()) {
      const sessions = await this.stripe.listRecentPaidSessions(from);
      for (const s of sessions)
        candidates.push({
          reference: s.reference,
          amountMinor: s.amountMinor,
          currency: s.currency,
          note: `Online (Stripe, ${s.currency}) · recovered by reconciliation`,
          meta: s.metadata as CandidateMeta,
        });
    }
    const result: ReconcileResult = { ...zero, scanned: candidates.length };

    // Keep only invoice charges, then do ONE batched ledger existence check for
    // the whole window (not a findFirst per charge — that was an N+1 over the
    // sweep). The cross-tenant read uses the privileged client; the POST still
    // goes through the normal tenant-scoped settlement path.
    const invoiceCands = candidates.filter((c) => c.meta.kind === "invoice" && c.meta.invoiceId && c.meta.schoolId);
    result.invoiceCharges = invoiceCands.length;
    if (invoiceCands.length === 0) return result;
    const refs = [...new Set(invoiceCands.map((c) => c.reference))];
    const existing = await client.payment.findMany({ where: { reference: { in: refs } }, select: { reference: true } });
    const have = new Set(existing.map((e: { reference: string | null }) => e.reference));

    const recovered: string[] = [];
    for (const c of invoiceCands) {
      if (have.has(c.reference)) continue;
      result.missing++;
      const rawAmt = c.meta.invoiceAmountMinor;
      const declared = typeof rawAmt === "number" ? rawAmt : Number(rawAmt ?? 0);
      const creditMinor = declared > 0 ? declared : c.amountMinor;
      const rawFee = c.meta.platformFeeMinor;
      const platformFeeMinor = typeof rawFee === "number" ? rawFee : Number(rawFee ?? 0);
      const outcome = await this.settlement.applyOnlinePayment({
        schoolId: c.meta.schoolId as string,
        invoiceId: c.meta.invoiceId as string,
        creditMinor,
        chargedMinor: c.amountMinor,
        currency: c.currency,
        reference: c.reference,
        payerId: c.meta.payerId,
        platformFeeMinor: Number.isFinite(platformFeeMinor) ? platformFeeMinor : 0,
        note: c.note,
      });
      if (outcome === "posted") {
        result.posted++;
        recovered.push(c.reference);
        this.logger.warn(`reconcile: recovered missed settlement ${c.reference} (invoice ${c.meta.invoiceId})`);
      }
    }
    // A recovered payment means webhooks WERE lost — the owner should know the
    // delivery path is unhealthy even though the money is now right.
    if (result.posted > 0) await this.alertOwners(client, result, recovered);
    return result;
  }

  private async alertOwners(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    result: ReconcileResult,
    recovered: string[],
  ): Promise<void> {
    try {
      const owners = await client.user.findMany({
        where: { roles: { some: { role: { name: "super_admin" } } } },
        select: { id: true, schoolId: true },
      });
      const shown = recovered.slice(0, 10).join(", ") + (recovered.length > 10 ? `, +${recovered.length - 10} more` : "");
      for (const owner of owners) {
        await this.notifications.enqueue(
          { schoolId: owner.schoolId, userId: owner.id },
          {
            recipientId: owner.id,
            type: "OPERATOR_ALERT",
            title: `Reconciliation recovered ${result.posted} missed payment${result.posted === 1 ? "" : "s"}`,
            body: `${result.posted} settled gateway charge(s) had no matching ledger payment and were posted by the sweep (refs: ${shown}). Money is now correct, but webhook delivery is unhealthy — check the webhook URL/logs.`,
            data: { ...result },
            channels: ["EMAIL"],
          },
        );
      }
    } catch (e) {
      this.logger.warn(`reconcile owner alert failed: ${(e as Error).message}`);
    }
  }
}
