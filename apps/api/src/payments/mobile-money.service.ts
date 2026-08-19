// =============================================================================
// MobileMoneyService — one rail-agnostic entry point
// =============================================================================
// Callers ask "charge this invoice by mobile money" and never name a provider.
// The school's REGION decides which rails exist; the platform's credentials decide
// which of those are usable; the payer picks from what is left.
//
// SETTLEMENT GOES THROUGH THE EXISTING SINGLE PATH. `InvoiceSettlementService` is
// already the one idempotent "post an online payment" implementation shared by the
// Paystack webhook, the verify-on-return confirm and the reconciliation sweep.
// Adding a second posting path is how two rails start disagreeing about whether an
// invoice is paid, so this one does not.
//
// THE SECURITY SHAPE. Paystack and Stripe sign their webhooks; M-Pesa and MTN do
// not. A callback here is a NOTIFICATION, never a source of truth about money: it
// is matched to a `MobileMoneyIntent` we wrote when the charge started, and the
// ledger is credited with OUR recorded amount. An attacker who finds the callback
// URL can, at worst, re-notify a charge that already happened.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  coverageFor,
  coverageOf,
  minorUnits,
  normaliseMsisdn,
  type MobileMoneyChargeDto,
  type MobileMoneyOptionDto,
  type MobileMoneyProviderKey,
  PAYMENT_CHANNELS,
} from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { SchoolRegionService } from "../foundation/school-region.service";
import { InvoiceSettlementService } from "../fees/settlement.service";
import { GatewayEventService } from "./gateway-event.service";
import {
  AirtelProvider,
  MpesaProvider,
  MtnMomoProvider,
  type MobileMoneyProvider, type CallbackReading } from "./mobile-money.provider";
import { PaymentChannelService } from "./payment-channel.service";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

type IntentRow = {
  id: string;
  schoolId: string;
  reference: string;
  provider: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  payerId: string | null;
  status: string;
  providerRef: string | null;
  createdAt: Date;
};

/** How long after a charge begins before it is worth asking the rail. The payer's
 *  own screen polls for 3 minutes, so this starts where that gives up. */
const MOBILE_MONEY_POLL_AFTER_MS = 4 * 60 * 1000;
/** Past this, stop polling and close the intent. Rails do not keep a charge
 *  queryable forever, and an intent that can never resolve must not circulate. */
const MOBILE_MONEY_ABANDON_MS = 3 * 24 * 60 * 60 * 1000;
/** Bounded so one sweep cannot run unboundedly long; a truncated run is LOGGED. */
const MOBILE_MONEY_SWEEP_LIMIT = 500;

export const MM_RECOVERY_QUEUE = "mobile-money-recovery";
export const MM_RECOVERY_JOB = "mobile-money-recovery";
export const MM_RECOVERY_SCHEDULER_ID = "mobile-money-recovery-scheduler";
/** Hourly, not daily. The card sweep runs daily because a card webhook that fails
 *  is retried by the gateway for days; a mobile-money callback is delivered ONCE,
 *  so a lost one is lost until we ask. An hour is the longest a parent should sit
 *  looking at an unpaid invoice they have already paid. */
export const DEFAULT_MM_RECOVERY_CRON = "17 * * * *";

export interface MobileMoneyRecoveryResult {
  scanned: number;
  settled: number;
  failed: number;
  stillPending: number;
  expired: number;
}

@Injectable()
export class MobileMoneyService {
  private readonly logger = new Logger("MobileMoney");
  private readonly providers: Map<MobileMoneyProviderKey, MobileMoneyProvider>;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly region: SchoolRegionService,
    private readonly settlement: InvoiceSettlementService,
    private readonly events: GatewayEventService,
    private readonly privileged: PrivilegedDatabaseService,
    mpesa: MpesaProvider,
    mtn: MtnMomoProvider,
    airtel: AirtelProvider,
    // LAST and @Optional deliberately — see the note in PaymentGatewayService.
    // Absent it FAILS OPEN: a missing switchboard must never stop a payment.
    @Optional() private readonly channels?: PaymentChannelService,
  ) {
    // A registry, not a switch. Adding a rail is one entry plus its adapter.
    this.providers = new Map<MobileMoneyProviderKey, MobileMoneyProvider>([
      [mpesa.key, mpesa],
      [mtn.key, mtn],
      [airtel.key, airtel],
    ]);
  }

  /**
   * What this school's payers can use.
   *
   * Rails the country has but the platform has no credentials for are returned
   * DISABLED rather than hidden — a school can then see what it could ask for,
   * instead of wondering why its neighbours have M-Pesa and it does not.
   */
  async options(schoolId: string): Promise<MobileMoneyOptionDto[]> {
    const region = await this.region.forSchool(schoolId);
    // The platform-wide switch AND the per-rail credentials both have to be on.
    // Reported here rather than only at charge time so a payer never picks a
    // rail that will refuse them a click later — the whole point of the
    // "coming soon" wording is that it appears BEFORE the attempt.
    const channelOn = (await this.channels?.isEnabled(PAYMENT_CHANNELS.MOBILE_MONEY)) ?? true;
    return coverageFor(region.country).map((c) => ({
      provider: c.provider,
      label: c.label,
      currency: c.currency,
      dialCode: c.dialCode,
      enabled: channelOn && (this.providers.get(c.provider)?.isConfigured() ?? false),
    }));
  }

  /**
   * Start a charge. ASYNCHRONOUS by nature — the payer approves on their handset,
   * so this returns an acknowledgement and the money arrives (or does not) later.
   */
  async charge(
    p: Principal,
    input: { invoiceId: string; provider: string; phone: string },
  ): Promise<MobileMoneyChargeDto> {
    await this.channels?.assertEnabled(PAYMENT_CHANNELS.MOBILE_MONEY);
    const region = await this.region.forSchool(p.schoolId);
    const cover = coverageOf(input.provider, region.country);
    if (!cover) {
      // Never silently fall back to a card rail: a payer who chose mobile money
      // and got a card page has been misled about what will be debited.
      const available = coverageFor(region.country).map((c) => c.label).join(", ") || "none";
      throw new BadRequestException(
        `${input.provider} does not operate in ${region.country}. Available here: ${available}.`,
      );
    }
    const provider = this.providers.get(cover.provider);
    if (!provider?.isConfigured()) {
      throw new BadRequestException(`${cover.label} is not enabled on this platform yet.`);
    }
    const msisdn = normaliseMsisdn(input.phone, cover.dialCode);
    if (!msisdn) throw new BadRequestException("That does not look like a valid mobile number.");

    const { intent, narrative } = await this.db.runAsTenant(
      { schoolId: p.schoolId, userId: p.userId },
      async (tx) => {
        const inv = (await tx.invoice.findFirst({
          where: { id: input.invoiceId },
          select: { id: true, totalMinor: true, currency: true, status: true, studentId: true },
        })) as { id: string; totalMinor: number; currency: string; status: string; studentId: string } | null;
        if (!inv) throw new NotFoundException("Invoice not found");
        if (inv.status === "PAID" || inv.status === "CANCELLED") {
          throw new BadRequestException(`This invoice is ${inv.status.toLowerCase()} — nothing is owed.`);
        }
        // The rail settles in the country's currency; an invoice raised in another
        // one cannot be paid on it without an FX decision nobody has made.
        if (inv.currency !== cover.currency) {
          throw new BadRequestException(
            `${cover.label} settles in ${cover.currency}; this invoice is in ${inv.currency}.`,
          );
        }
        const paid = (await tx.payment.aggregate({
          where: { invoiceId: inv.id, status: "POSTED" },
          _sum: { amountMinor: true },
        } as never)) as unknown as { _sum: { amountMinor: number | null } };
        let outstanding = Math.max(0, inv.totalMinor - (paid._sum.amountMinor ?? 0));
        if (outstanding <= 0) throw new BadRequestException("This invoice is already settled.");

        // A rail that only takes whole units (M-Pesa) gets a whole-unit ask, floored.
        // FLOORED, never rounded: rounding up debits the payer more than we credit
        // them, and the difference is invisible on both sides. Flooring leaves the
        // fraction outstanding on the invoice, where it is visible and payable.
        if (provider.wholeUnitsOnly) {
          const step = minorUnits(inv.currency);
          const whole = Math.floor(outstanding / step) * step;
          if (whole <= 0) {
            throw new BadRequestException(
              `The balance is less than the smallest amount ${cover.label} accepts. Please pay it another way.`,
            );
          }
          outstanding = whole;
        }

        // OUR figure, written before the prompt goes out. The callback can never
        // change it.
        const reference = `MM-${randomUUID().replace(/-/g, "").slice(0, 18).toUpperCase()}`;
        const row = (await tx.mobileMoneyIntent.create({
          data: {
            schoolId: p.schoolId,
            reference,
            provider: cover.provider,
            invoiceId: inv.id,
            amountMinor: outstanding,
            currency: inv.currency,
            msisdn,
            payerId: p.userId,
          },
        })) as IntentRow;
        return { intent: row, narrative: `School fees` };
      },
    );

    try {
      const ack = await provider.charge({
        reference: intent.reference,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        msisdn,
        country: cover.country,
        dialCode: cover.dialCode,
        narrative,
        // THE ADDRESS A RAIL CAN ACTUALLY REACH.
        //
        // This was built from PUBLIC_API_URL, which is set nowhere — not in
        // compose, not in .env.example, not in the task definition — so the
        // rails were handed `/payments/mobile-money/callback/mpesa`, a path with
        // no host. And even set, it pointed at the API, which is not
        // internet-facing: the ALB forwards only /ws/* to it and REST flows
        // web→api over Cloud Map.
        //
        // The reachable route already exists — the web tier's webhook proxy
        // allowlists /api/webhooks/mobile-money/<provider> and forwards it to
        // exactly this controller — and PUBLIC_WEB_URL is set in the task
        // definition, because the acceptance email depends on it too.
        //
        // What this cost: nothing is LOST, because these rails are unsigned and
        // deliver once, so the hourly recovery sweep exists precisely to settle
        // what no callback closed. But every mobile-money payment would have
        // waited up to an hour for a sweep instead of settling on the callback,
        // and the sweep would have been carrying the whole rail rather than
        // catching its misses.
        callbackUrl: this.callbackUrl(cover.provider),
      });
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        tx.mobileMoneyIntent.update({ where: { id: intent.id }, data: { providerRef: ack.providerRef } }),
      );
      return { reference: intent.reference, provider: cover.provider, status: "PENDING", instruction: ack.instruction };
    } catch (err) {
      // The rail refused. Mark it so the payer is not left with a PENDING row that
      // will never resolve, and so the sweep does not keep looking at it.
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        tx.mobileMoneyIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED", failureReason: (err as Error).message.slice(0, 400) },
        }),
      );
      throw err;
    }
  }

  /**
   * Handle a rail's callback.
   *
   * PUBLIC and UNSIGNED, so it is treated as a doorbell and not as a statement of
   * fact. Everything that matters — school, invoice, amount — comes from the intent
   * we wrote when the charge began.
   */
  async handleCallback(providerKey: string, body: unknown): Promise<{ ok: true }> {
    const provider = this.providers.get(providerKey.toUpperCase() as MobileMoneyProviderKey);
    // Always 200 to the rail: an error response makes it retry forever, and there
    // is nothing a retry can fix about a payload we cannot read.
    if (!provider) return { ok: true };

    const reading = provider.readCallback(body);
    // A rail may identify the charge by OUR reference or by ITS OWN id, and M-Pesa
    // only does the latter — Daraja's callback carries CheckoutRequestID and never
    // echoes the account reference we sent. Either is enough to find the intent.
    if (!reading.reference && !reading.providerRef) {
      this.logger.warn(`${providerKey} callback identifies no charge`);
      return { ok: true };
    }

    // The callback has no session, so it cannot open a tenant transaction until we
    // know the school. Resolving the intent through the privileged client is the
    // same shape the Paystack webhook uses.
    const client = this.privileged.client;
    if (!client) {
      this.logger.error("Mobile-money callback received but the privileged client is unconfigured");
      return { ok: true };
    }
    const intent = (await client.mobileMoneyIntent.findFirst({
      where: reading.reference
        ? { reference: reading.reference }
        : { providerRef: reading.providerRef!, provider: providerKey.toUpperCase() },
    })) as IntentRow | null;
    if (!intent) {
      this.logger.warn(
        `${providerKey} callback for unknown charge (ref=${reading.reference} providerRef=${reading.providerRef})`,
      );
      return { ok: true };
    }

    // THE CALLBACK SAYS SO. THAT IS NOT EVIDENCE.
    //
    // This endpoint is public, unauthenticated and UNSIGNED — M-Pesa and MTN
    // sign nothing — and the file already reasons that amounts must come from
    // the intent rather than the body. The OUTCOME is a statement of fact too,
    // and it was taken on trust.
    //
    // The payer knows their own reference: `charge()` returns it to them. So a
    // parent could start a charge, DECLINE the prompt, and POST a success-shaped
    // body here carrying that reference — and the invoice settled for the full
    // amount with no money moved. Nothing corrects it afterwards: applyReading
    // returns early once the intent is no longer PENDING, so the recovery sweep
    // never revisits it, and settlement is idempotent on the reference.
    //
    // So the callback is demoted to what the comment above already calls it — a
    // doorbell. We go and ASK the rail, with the same `getStatus` the recovery
    // sweep uses, and act on the answer. A forged body now buys an attacker one
    // outbound status query.
    let verified: CallbackReading;
    try {
      verified = await provider.getStatus({ reference: intent.reference, providerRef: intent.providerRef });
    } catch (err) {
      // Could not ask. Leave it PENDING so the sweep tries again — settling or
      // failing on an unverified claim is exactly what this guard exists to
      // stop, and 2xx keeps the rail from retrying forever.
      this.logger.warn(
        `${providerKey} callback for ${intent.reference}: could not verify with the rail (${(err as Error).message.slice(0, 120)}) — left PENDING`,
      );
      return { ok: true };
    }
    if (verified.outcome !== reading.outcome) {
      // Worth seeing: either a rail that changed its mind between notifying and
      // being asked, or somebody posting a body the rail does not agree with.
      this.logger.warn(
        `${providerKey} callback for ${intent.reference} claimed ${reading.outcome}, rail says ${verified.outcome}`,
      );
    }
    // The recorded payload stays the CALLBACK's, so gateway_event still answers
    // "what did a rail tell us, and when"; the verdict acted on is the rail's.
    await this.applyReading(intent, verified, body);
    return { ok: true };
  }

  /**
   * Apply a rail's verdict to an intent. THE one place a mobile-money charge
   * resolves, whether we heard it from a callback or asked for it ourselves.
   *
   * Deliberately shared: a recovery sweep that reimplemented this would be a
   * second posting path, which is the thing InvoiceSettlementService exists to
   * prevent. Both triggers land here, and both are idempotent — on the intent's
   * PENDING status first, and on the gateway reference inside settlement.
   */
  private async applyReading(intent: IntentRow, reading: CallbackReading, payload: unknown): Promise<void> {
    // Idempotent: a rail that re-notifies a settled charge changes nothing.
    if (intent.status !== "PENDING") return;
    // "We do not know" is not an outcome. Leaving it PENDING means the sweep will
    // ask again; settling or failing it here would be a one-way guess.
    if (reading.outcome === "PENDING") return;

    // Logged in the SAME append-only gateway_event table as Paystack and Stripe:
    // one place answers "what did a rail tell us, and when", whatever the rail.
    await this.events.record({
      schoolId: intent.schoolId,
      gateway: intent.provider as "MPESA" | "MTN_MOMO" | "AIRTEL",
      eventType: `mobile_money.${reading.outcome.toLowerCase()}`,
      reference: reading.reference ?? intent.reference,
      payload,
    });

    const ctx = { schoolId: intent.schoolId, userId: intent.payerId ?? SYSTEM_ACTOR_ID };

    if (reading.outcome === "FAILED") {
      await this.db.runAsTenant(ctx, (tx) =>
        tx.mobileMoneyIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED", failureReason: reading.failureReason ?? "Payment was not completed" },
        }),
      );
      return;
    }

    // SUCCEEDED. Credit OUR recorded amount through the one settlement path, which
    // is itself idempotent on the reference — so a callback racing the recovery
    // sweep posts once, not twice.
    const outcome = await this.settlement.applyOnlinePayment({
      schoolId: intent.schoolId,
      invoiceId: intent.invoiceId,
      creditMinor: intent.amountMinor,
      chargedMinor: intent.amountMinor,
      currency: intent.currency,
      reference: intent.reference,
      payerId: intent.payerId ?? undefined,
      note: `Mobile money (${intent.provider})`,
      method: "BANK_TRANSFER",
    });
    // A currency mismatch means money moved that we are refusing to post. The
    // intent must NOT read as settled, or nothing will ever revisit it.
    if (outcome === "currency_mismatch") {
      this.logger.error(
        `mobile money ${intent.reference}: charged ${intent.currency} against a different-currency invoice — NOT posted`,
      );
      await this.db.runAsTenant(ctx, (tx) =>
        tx.mobileMoneyIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED", failureReason: "Currency mismatch — needs manual reconciliation" },
        }),
      );
      return;
    }
    await this.db.runAsTenant(ctx, (tx) =>
      tx.mobileMoneyIntent.update({
        where: { id: intent.id },
        data: {
          status: "SUCCEEDED",
          settledAt: new Date(),
          providerRef: reading.providerRef ?? intent.providerRef ?? intent.provider,
          ...(outcome === "invoice_missing" ? { failureReason: "Invoice no longer exists" } : {}),
        },
      }),
    );
  }

  /**
   * RECOVERY SWEEP — ask the rails about charges we never heard back about.
   *
   * A mobile-money callback is unsigned, delivered once, best-effort, and is the
   * ONLY thing that tells us a payment succeeded. Lose one to a deploy, a 5xx or a
   * network blip and the payer has been debited while the invoice stays open
   * forever. The card rails have had a reconciliation sweep for exactly this since
   * the payments-completion program; mobile money — the LESS reliable rail — had
   * none. This is that missing half.
   *
   * It is also what makes the payer-facing message honest. The checkout screen
   * gives up after three minutes with "if your phone was debited, the payment will
   * appear shortly" — a promise nothing was keeping.
   *
   * Cross-tenant by nature (a rail's charges span schools), so it runs on the
   * PRIVILEGED client to FIND intents, exactly like dunning and reconciliation —
   * but every WRITE goes back through the tenant-scoped path under that intent's
   * own school, so RLS still governs the ledger.
   */
  async recoverPending(trigger: "SCHEDULED" | "MANUAL"): Promise<MobileMoneyRecoveryResult> {
    const result: MobileMoneyRecoveryResult = { scanned: 0, settled: 0, failed: 0, stillPending: 0, expired: 0 };
    const client = this.privileged.client;
    if (!client) {
      if (trigger === "SCHEDULED") this.logger.log("mobile-money recovery skipped (no privileged client)");
      return result;
    }

    const now = Date.now();
    // Only charges old enough that a callback SHOULD have arrived — polling a
    // 10-second-old prompt just races the payer's own handset.
    const before = new Date(now - MOBILE_MONEY_POLL_AFTER_MS);
    // And not so old the rail has forgotten them. Past this, a still-PENDING
    // intent is closed as expired rather than polled forever.
    const floor = new Date(now - MOBILE_MONEY_ABANDON_MS);

    const pending = (await client.mobileMoneyIntent.findMany({
      where: { status: "PENDING", createdAt: { lt: before } },
      orderBy: { createdAt: "asc" },
      take: MOBILE_MONEY_SWEEP_LIMIT,
    })) as IntentRow[];
    result.scanned = pending.length;
    // NO SILENT CAP: if the sweep is truncating, say so — a capped sweep that
    // looks complete is how a backlog hides.
    if (pending.length === MOBILE_MONEY_SWEEP_LIMIT) {
      this.logger.warn(`mobile-money recovery hit its ${MOBILE_MONEY_SWEEP_LIMIT}-intent cap; more remain`);
    }

    for (const intent of pending) {
      // Abandon FIRST, before even looking at the rail. A charge this old is
      // closed because nobody will ever answer for it — which is just as true, and
      // more so, when the rail has since been decommissioned or its credentials
      // pulled. Checking isConfigured first would strand those intents PENDING for
      // ever, on exactly the rails least likely to come back.
      if (intent.createdAt < floor) {
        result.expired++;
        await this.db.runAsTenant(
          { schoolId: intent.schoolId, userId: intent.payerId ?? SYSTEM_ACTOR_ID },
          (tx) =>
            tx.mobileMoneyIntent.update({
              where: { id: intent.id },
              data: {
                // EXPIRED, not FAILED: the rail never told us it failed — we
                // stopped asking. The distinction matters to whoever reconciles
                // it, because an EXPIRED charge may still have taken money.
                status: "EXPIRED",
                failureReason: "No confirmation received — please check with your provider before paying again.",
              },
            }),
        );
        continue;
      }

      const provider = this.providers.get(intent.provider as MobileMoneyProviderKey);
      if (!provider?.isConfigured()) continue;

      let reading: CallbackReading;
      try {
        reading = await provider.getStatus({ reference: intent.reference, providerRef: intent.providerRef });
      } catch (err) {
        // One rail being down must not stop the sweep for the others.
        this.logger.warn(`recovery poll failed for ${intent.reference}: ${(err as Error).message}`);
        result.stillPending++;
        continue;
      }
      if (reading.outcome === "PENDING") {
        result.stillPending++;
        continue;
      }
      await this.applyReading(intent, reading, { source: "recovery-sweep", reading });
      if (reading.outcome === "SUCCEEDED") {
        result.settled++;
        // A recovered payment means a callback WAS lost. Say so — the money is
        // right now, but the delivery path is not.
        this.logger.warn(`recovery: settled ${intent.reference} that no callback ever arrived for`);
      } else {
        result.failed++;
      }
    }
    return result;
  }

  /**
   * Where a rail should call back, on a host it can resolve.
   *
   * Empty when PUBLIC_WEB_URL is unset rather than half a URL: a rail that
   * validates the address fails the charge loudly, which is better than one
   * that accepts nonsense and calls nobody.
   */
  private callbackUrl(provider: string): string {
    const base = process.env.PUBLIC_WEB_URL;
    if (!base) {
      this.logger.warn(
        "PUBLIC_WEB_URL is not set — mobile-money charges are going out with no callback address, so nothing will settle until the recovery sweep runs.",
      );
      return "";
    }
    return `${base}/api/webhooks/mobile-money/${provider.toLowerCase()}`;
  }

  /** A payer polling their own charge — mobile money is asynchronous, so the
   *  screen has to ask. Scoped to the caller's school by RLS. */
  async status(p: Principal, reference: string) {
    return this.db.runAsTenantReadOnly({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      const row = (await tx.mobileMoneyIntent.findFirst({
        where: { reference },
        select: { reference: true, provider: true, status: true, failureReason: true, amountMinor: true, currency: true },
      })) as Record<string, unknown> | null;
      if (!row) throw new NotFoundException("Not found");
      return row;
    });
  }
}
