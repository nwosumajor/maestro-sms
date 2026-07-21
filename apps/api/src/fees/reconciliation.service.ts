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

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger("Reconcile");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly settlement: InvoiceSettlementService,
  ) {}

  /** Manual trigger (fee.reconcile.run — super_admin). Audited to the caller. */
  async runManual(p: Principal): Promise<ReconcileResult> {
    if (!this.paystack.isConfigured()) {
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
    if (!this.paystack.isConfigured() || !client) {
      if (trigger === "SCHEDULED") this.logger.log("reconcile skipped (gateway or privileged client unconfigured)");
      return zero;
    }
    const from = new Date(Date.now() - RECONCILE_WINDOW_DAYS * 86_400_000);
    const txs = await this.paystack.listSuccessfulTransactions(from);
    const result: ReconcileResult = { ...zero, scanned: txs.length };
    const recovered: string[] = [];
    for (const t of txs) {
      const meta = t.metadata as {
        kind?: string;
        invoiceId?: string;
        schoolId?: string;
        payerId?: string;
        invoiceAmountMinor?: number;
        platformFeeMinor?: number;
      };
      if (meta.kind !== "invoice" || !meta.invoiceId || !meta.schoolId) continue;
      result.invoiceCharges++;
      // Cross-tenant existence check (privileged); the POST goes through the
      // normal tenant-scoped settlement path.
      const existing = await client.payment.findFirst({ where: { reference: t.reference }, select: { id: true } });
      if (existing) continue;
      result.missing++;
      const creditMinor =
        typeof meta.invoiceAmountMinor === "number" && meta.invoiceAmountMinor > 0
          ? meta.invoiceAmountMinor
          : t.amountMinor;
      const outcome = await this.settlement.applyOnlinePayment({
        schoolId: meta.schoolId,
        invoiceId: meta.invoiceId,
        creditMinor,
        chargedMinor: t.amountMinor,
        reference: t.reference,
        payerId: meta.payerId,
        platformFeeMinor: typeof meta.platformFeeMinor === "number" ? meta.platformFeeMinor : 0,
        note: "Online (Paystack) · recovered by reconciliation",
      });
      if (outcome === "posted") {
        result.posted++;
        recovered.push(t.reference);
        this.logger.warn(`reconcile: recovered missed settlement ${t.reference} (invoice ${meta.invoiceId})`);
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
