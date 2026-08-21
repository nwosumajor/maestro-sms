// =============================================================================
// MessageCreditsService — prepaid SMS/WhatsApp credits (metered consumable)
// =============================================================================
// A school buys a bundle (MESSAGE_CREDIT_BUNDLES); the verified webhook credits
// the APPEND-ONLY message_credit_entry ledger (idempotent on the gateway
// reference); each SMS/WhatsApp delivery debits 1 credit in the SAME tenant
// transaction as the delivery row update. Balance = SUM(deltaCredits). A school
// with no credits fails those deliveries soft ("no message credits") — email +
// in-app are never affected.

import { BadRequestException, forwardRef, Inject, Injectable, Logger, ServiceUnavailableException, Optional} from "@nestjs/common";
import { MESSAGE_CREDIT_BUNDLES, CURRENCIES,
  PAYMENT_CHANNELS, MESSAGE_CREDIT_LOW_THRESHOLD, type MessageCreditLedgerPageDto } from "@sms/types";
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
import { NotificationService } from "./notification.service";
import { prisma } from "@sms/db";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

@Injectable()
export class MessageCreditsService {
  private readonly logger = new Logger("MessageCredits");
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly paystack: PaystackService,
    // Cross-tenant reads only: a gateway callback and the reconciliation
    // sweep both arrive with no tenant context, and the app role sees zero
    // rows on an RLS table without one. Every WRITE still goes through
    // runAsTenant, scoped to the school the metadata names.
    @Optional() private readonly privileged?: PrivilegedDatabaseService,
    // LAST and @Optional deliberately. DI always provides it in the running
    // app; being optional keeps every existing unit wiring compiling, and
    // absent it FAILS OPEN — a missing switchboard must never be the reason a
    // parent cannot pay. It gates a commercial choice, not a security boundary.
    @Optional() private readonly channels?: PaymentChannelService,
    // NotificationService injects THIS service, so taking it directly would be
    // a cycle. forwardRef + @Optional keeps the warning best-effort and keeps
    // the module graph acyclic — module-graph.spec pins that.
    @Optional() @Inject(forwardRef(() => NotificationService)) private readonly notifications?: NotificationService,
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
      // Bring the school BACK so the page can settle immediately. Without this
      // the whole purchase depended on a webhook arriving — and when one did
      // not, three bundles worth NGN 74,000 were charged by the gateway and
      // never became credits: no balance, no ledger row, nothing to explain
      // where the money went. Fees and subscriptions both learned this already.
      callbackUrl: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/billing?verifyCredits=${encodeURIComponent(reference)}`,
    });
    return { authorizationUrl, reference };
  }

  /** Verified webhook (metadata.kind === "credits"): credit the ledger once.
   *  The bundle is re-resolved SERVER-SIDE and the settled amount checked —
   *  metadata can never mint more credits than were paid for. */
  /**
   * VERIFY ON RETURN — the school is back from the gateway; settle the bundle.
   *
   * Same shape as the subscription one: verify against the gateway, then apply
   * through the SAME idempotent applyPurchase the webhook uses, so a late
   * webhook cannot credit the bundle twice.
   */
  async verifyPurchase(p: Principal, reference: string): Promise<{ credited: boolean; balance: number }> {
    if (!(await this.hasEntryForReference(reference))) {
      const verified = await this.paystack.verifyTransaction(reference);
      const meta = (verified?.metadata ?? {}) as { schoolId?: string };
      // Never settle another school's reference into this one.
      if (verified?.status === "success" && meta.schoolId === p.schoolId) {
        await this.applyPurchase({
          event: "charge.success",
          data: {
            amount: verified.amountMinor,
            currency: verified.currency,
            reference,
            metadata: verified.metadata,
          },
        } as never);
      }
    }
    const credited = await this.hasEntryForReference(reference);
    const balance = await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.balanceInTx(tx, p.schoolId),
    );
    return { credited, balance };
  }

  /**
   * Has this gateway reference already produced a ledger entry?
   *
   * PRIVILEGED read: message_credit_entry is RLS-protected and the callers here
   * (a gateway callback, a cross-tenant sweep) have no tenant context. Under the
   * app role with no GUC set this returns zero rows for every school, which
   * reads as "not credited yet" — the exact false negative that would credit a
   * bundle twice.
   */
  async hasEntryForReference(reference: string): Promise<boolean> {
    const client = this.privileged?.client;
    if (!client) return false;
    return (await client.messageCreditEntry.findFirst({ where: { reference }, select: { id: true } })) !== null;
  }

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
  /**
   * The school's OWN credit ledger.
   *
   * The operator could always drill into any school's entries; the school could
   * see only a number. A parent gets a full payment history with receipts, and
   * a bursar asking "where did 200 credits go?" had nothing to look at. Same
   * data the operator sees, scoped by RLS to the caller's own school.
   *
   * Paged and newest-first: this table grows with every message ever sent, so
   * it must never be returned whole.
   */
  async ledger(p: Principal, page = 1, pageSize = 25): Promise<MessageCreditLedgerPageDto> {
    const take = Math.min(100, Math.max(1, pageSize));
    const skip = (Math.max(1, page) - 1) * take;
    return this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      const [rows, balance] = await Promise.all([
        tx.messageCreditEntry.findMany({
          // CHECKPOINTs are bookkeeping, not activity — showing them would put
          // rows a school never caused in the middle of its own history.
          where: { reason: { not: "CHECKPOINT" } },
          orderBy: { createdAt: "desc" },
          skip,
          // One extra row to detect a next page. A COUNT here would scan every
          // message the school has ever sent — 70ms at 900,000 entries and
          // growing for ever — to produce a number nobody asked for.
          take: take + 1,
        }),
        this.balanceInTx(tx, p.schoolId),
      ]);
      const hasMore = (rows as unknown[]).length > take;
      const page_ = (rows as unknown[]).slice(0, take);
      return {
        balance,
        page: Math.max(1, page),
        pageSize: take,
        hasMore,
        rows: (page_ as Array<Record<string, unknown>>).map((r) => ({
          id: r.id as string,
          deltaCredits: r.deltaCredits as number,
          reason: r.reason as string,
          channel: (r.channel as string | null) ?? null,
          reference: (r.reference as string | null) ?? null,
          createdAt: r.createdAt as Date,
        })),
      };
    });
  }

  /**
   * REFUND a credit for a message the provider later reported as failed.
   *
   * `ok` from the send call means the provider ACCEPTED the message, not that
   * it arrived. A carrier reject, an unreachable handset or a blocked number
   * comes back minutes later on a status callback — and until now the school
   * had already been charged for it and stayed charged.
   *
   * Idempotent on the provider's own id: a provider may deliver the same status
   * callback more than once, and a second refund would hand back a credit that
   * was never spent.
   */
  async refundFailedSend(providerRef: string, status: string): Promise<{ refunded: boolean }> {
    // PRIVILEGED: a delivery-status callback carries only the provider's id —
    // no session and no tenant — so the school has to be found across tenants.
    const client = this.privileged?.client;
    if (!client) return { refunded: false };
    const debit = await client.messageCreditEntry.findFirst({
      where: { providerRef, reason: "SEND" },
      select: { id: true, schoolId: true, channel: true },
    });
    if (!debit) return { refunded: false };
    const already = await client.messageCreditEntry.findFirst({
      where: { providerRef, reason: "REFUND" },
      select: { id: true },
    });
    if (already) return { refunded: false };

    await this.db.runAsTenant({ schoolId: debit.schoolId, userId: SYSTEM_ACTOR_ID }, (tx) =>
      tx.messageCreditEntry.create({
        data: {
          schoolId: debit.schoolId,
          // The ledger is append-only: a refund is a NEW entry, never an edit
          // of the debit. The history keeps both, which is what makes the
          // reconciliation sweep able to explain the balance.
          deltaCredits: 1,
          reason: "REFUND",
          channel: debit.channel,
          reference: `${status}`,
          providerRef,
        },
      }),
    );
    this.logger.log(`refunded 1 credit for ${providerRef} (${status})`);
    return { refunded: true };
  }

  /**
   * Debit one credit for a delivery, in the delivery's OWN tenant transaction.
   * Call ONLY after the gateway has CONFIRMED the send — a failed delivery
   * (bad number, gateway error, timeout) must never consume a paid credit. A
   * rare concurrent race can still dip the balance one or two below zero; the
   * next purchase absorbs it (bounded, self-healing — unchanged from before).
   */
  /**
   * Warn the school when a send takes it to or below the low threshold, and
   * again when the balance actually hits zero.
   *
   * WHY IT IS NEEDED AT ALL: running out is invisible from inside the school.
   * The in-app inbox and email still go out, so nothing looks broken — only the
   * SMS and WhatsApp copies silently stop. The first anyone hears of it is a
   * parent asking why nobody told them their child was absent.
   *
   * Fires on the CROSSING, not on the state, so a school at zero is not told
   * every single time it tries to send. Best-effort and never inside the
   * caller's failure path: a warning that fails must not fail the delivery it
   * was warning about.
   */
  private async warnIfLow(tx: TenantTx, schoolId: string, balanceAfter: number): Promise<void> {
    const crossedZero = balanceAfter === 0;
    const crossedLow = balanceAfter === MESSAGE_CREDIT_LOW_THRESHOLD;
    if (!crossedZero && !crossedLow) return;
    try {
      const staff = await tx.userRole.findMany({
        where: { role: { name: { in: ["school_admin", "principal"] } } },
        select: { userId: true },
        take: 20,
      });
      for (const s of staff) {
        await this.notifications?.enqueue(
          { schoolId, userId: SYSTEM_ACTOR_ID },
          {
            recipientId: s.userId,
            type: "BILLING",
            title: crossedZero ? "SMS and WhatsApp have stopped — no message credits" : "Message credits are running low",
            body: crossedZero
              ? "Your school has run out of message credits, so SMS and WhatsApp alerts are no longer being sent. " +
                "Parents still receive in-app and email notifications. Buy a bundle on the Billing page to restart them."
              : `Only ${balanceAfter} message credits left. SMS and WhatsApp alerts stop when they run out — ` +
                "in-app and email keep working. Top up on the Billing page.",
            data: { balance: balanceAfter },
          },
        );
      }
    } catch {
      /* a warning must never cost the delivery it was warning about */
    }
  }

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
    await this.warnIfLow(tx, schoolId, await this.balanceInTx(tx, schoolId));
  }
}
