// =============================================================================
// MessageCreditsService — prepaid SMS/WhatsApp credits (metered consumable)
// =============================================================================
// A school buys a bundle (MESSAGE_CREDIT_BUNDLES); the verified webhook credits
// the APPEND-ONLY message_credit_entry ledger (idempotent on the gateway
// reference); each SMS/WhatsApp delivery debits 1 credit in the SAME tenant
// transaction as the delivery row update. Balance = SUM(deltaCredits). A school
// with no credits fails those deliveries soft ("no message credits") — email +
// in-app are never affected.

import { BadRequestException, Inject, Injectable, ServiceUnavailableException, Optional} from "@nestjs/common";
import { MESSAGE_CREDIT_BUNDLES, CURRENCIES,
  PAYMENT_CHANNELS,
} from "@sms/types";
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
import { PaymentChannelService } from "../payments/payment-channel.service";

@Injectable()
export class MessageCreditsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    // LAST and @Optional deliberately. DI always provides it in the running
    // app; being optional keeps every existing unit wiring compiling, and
    // absent it FAILS OPEN — a missing switchboard must never be the reason a
    // parent cannot pay. It gates a commercial choice, not a security boundary.
    @Optional() private readonly channels?: PaymentChannelService,
  ) {}

  /**
   * The school's credit balance.
   *
   * Still SUM(deltaCredits) — a stored counter can drift from its own history
   * and this one cannot — but bounded by the newest CHECKPOINT rather than
   * summing the entire ledger. That sum runs before EVERY message, and at
   * 900,000 entries (a school sending 500/day for five years) it measured as a
   * 64ms Parallel Seq Scan, so 500 messages cost 32 seconds of arithmetic.
   *
   * With no checkpoint yet it falls back to the full sum, which is exactly
   * right for a young school and is what every existing school gets until the
   * reconciliation sweep writes its first one.
   */
  async balanceInTx(tx: TenantTx, schoolId: string): Promise<number> {
    const checkpoint = await tx.messageCreditEntry.findFirst({
      where: { schoolId, reason: "CHECKPOINT" },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true, createdAt: true },
    });
    const agg = await tx.messageCreditEntry.aggregate({
      where: checkpoint
        ? { schoolId, createdAt: { gt: checkpoint.createdAt } }
        : { schoolId },
      _sum: { deltaCredits: true },
    });
    return (checkpoint?.balanceAfter ?? 0) + (agg._sum.deltaCredits ?? 0);
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
    await this.channels?.assertEnabled(PAYMENT_CHANNELS.PAYSTACK);
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor: bundle.priceMinor,
      // MESSAGE_CREDIT_BUNDLES are priced in NGN, so the charge is too.
      currency: CURRENCIES.NGN,
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

  /** Check (without spending) whether the school has any credit available. Call
   *  BEFORE attempting a gateway send — an empty balance skips the attempt
   *  entirely so a school never gets billed by the gateway for a send it
   *  can't pay for. */
  async hasBalanceInTx(tx: TenantTx, schoolId: string): Promise<boolean> {
    return (await this.balanceInTx(tx, schoolId)) > 0;
  }

  /**
   * Debit one credit for a delivery, in the delivery's OWN tenant transaction.
   * Call ONLY after the gateway has CONFIRMED the send — a failed delivery
   * (bad number, gateway error, timeout) must never consume a paid credit. A
   * rare concurrent race can still dip the balance one or two below zero; the
   * next purchase absorbs it (bounded, self-healing — unchanged from before).
   */
  async debitInTx(
    tx: TenantTx,
    schoolId: string,
    channel: string,
    notificationId: string,
    providerRef?: string,
  ): Promise<void> {
    await tx.messageCreditEntry.create({
      // providerRef is the PROVIDER's id for the message this credit paid for.
      // It is what the reconciliation sweep matches on: the platform is billed
      // per message and charges per credit, and without it the two counts could
      // never be compared. Null on a provider that does not return one.
      data: { schoolId, deltaCredits: -1, reason: "SEND", channel, reference: notificationId, providerRef },
    });
  }
}
