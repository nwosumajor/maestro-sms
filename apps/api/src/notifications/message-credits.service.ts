// =============================================================================
// MessageCreditsService — prepaid SMS/WhatsApp credits (metered consumable)
// =============================================================================
// A school buys a bundle (MESSAGE_CREDIT_BUNDLES); the verified webhook credits
// the APPEND-ONLY message_credit_entry ledger (idempotent on the gateway
// reference); each SMS/WhatsApp delivery debits 1 credit in the SAME tenant
// transaction as the delivery row update. Balance = SUM(deltaCredits). A school
// with no credits fails those deliveries soft ("no message credits") — email +
// in-app are never affected.

import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { MESSAGE_CREDIT_BUNDLES } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";

@Injectable()
export class MessageCreditsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
  ) {}

  async balanceInTx(tx: TenantTx, schoolId: string): Promise<number> {
    const agg = await tx.messageCreditEntry.aggregate({
      where: { schoolId },
      _sum: { deltaCredits: true },
    });
    return agg._sum.deltaCredits ?? 0;
  }

  /** The billing screen's credits panel. */
  async overview(p: Principal): Promise<{ balance: number; bundles: typeof MESSAGE_CREDIT_BUNDLES }> {
    const balance = await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.balanceInTx(tx, p.schoolId),
    );
    return { balance, bundles: MESSAGE_CREDIT_BUNDLES };
  }

  /** Start a hosted checkout for a bundle (NGN/Paystack; billing.manage+step-up
   *  at the controller). No pending row — the webhook writes the ledger entry,
   *  idempotent on the reference. */
  async initPurchase(p: Principal, bundleId: string): Promise<{ authorizationUrl: string; reference: string }> {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const bundle = MESSAGE_CREDIT_BUNDLES.find((b) => b.id === bundleId);
    if (!bundle) throw new BadRequestException("Unknown bundle");
    const email = await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: p.userId }, select: { email: true } });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "billing.credits.checkout",
          entity: "message_credit_entry",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { bundleId: bundle.id, credits: bundle.credits, priceMinor: bundle.priceMinor },
        },
        tx,
      );
      return user?.email ?? "billing@school";
    });
    const reference = `CRD-${p.schoolId.slice(0, 8)}-${Date.now()}`;
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor: bundle.priceMinor,
      reference,
      metadata: { kind: "credits", schoolId: p.schoolId, bundleId: bundle.id },
    });
    return { authorizationUrl, reference };
  }

  /** Verified webhook (metadata.kind === "credits"): credit the ledger once.
   *  The bundle is re-resolved SERVER-SIDE and the settled amount checked —
   *  metadata can never mint more credits than were paid for. */
  async applyPurchase(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const { schoolId, bundleId } = (event.data.metadata ?? {}) as { schoolId?: string; bundleId?: string };
    if (!schoolId || !bundleId) return { ok: true };
    const bundle = MESSAGE_CREDIT_BUNDLES.find((b) => b.id === bundleId);
    if (!bundle || event.data.amount < bundle.priceMinor) return { ok: true }; // never under-paid credits
    await this.db.runAsTenant({ schoolId, userId: SYSTEM_ACTOR_ID }, async (tx) => {
      const already = await tx.messageCreditEntry.findFirst({
        where: { reference: event.data.reference },
        select: { id: true },
      });
      if (already) return; // gateway retry — idempotent
      await tx.messageCreditEntry.create({
        data: {
          schoolId,
          deltaCredits: bundle.credits,
          reason: "PURCHASE",
          reference: event.data.reference,
        },
      });
    });
    return { ok: true };
  }

  /**
   * Debit one credit for an SMS/WhatsApp delivery, in the delivery's OWN tenant
   * transaction. Returns false (no debit) when the balance is empty — the
   * caller fails that delivery soft. A rare concurrent race can dip the balance
   * one or two below zero; the next purchase absorbs it (bounded, self-healing).
   */
  async debitInTx(tx: TenantTx, schoolId: string, channel: string, notificationId: string): Promise<boolean> {
    const balance = await this.balanceInTx(tx, schoolId);
    if (balance <= 0) return false;
    await tx.messageCreditEntry.create({
      data: { schoolId, deltaCredits: -1, reason: "SEND", channel, reference: notificationId },
    });
    return true;
  }
}
