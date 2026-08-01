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

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  coverageFor,
  coverageOf,
  normaliseMsisdn,
  type MobileMoneyChargeDto,
  type MobileMoneyOptionDto,
  type MobileMoneyProviderKey,
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
  type MobileMoneyProvider,
} from "./mobile-money.provider";
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
};

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
    return coverageFor(region.country).map((c) => ({
      provider: c.provider,
      label: c.label,
      currency: c.currency,
      dialCode: c.dialCode,
      enabled: this.providers.get(c.provider)?.isConfigured() ?? false,
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
        const outstanding = Math.max(0, inv.totalMinor - (paid._sum.amountMinor ?? 0));
        if (outstanding <= 0) throw new BadRequestException("This invoice is already settled.");

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
        narrative,
        callbackUrl: `${process.env.PUBLIC_API_URL ?? ""}/payments/mobile-money/callback/${cover.provider.toLowerCase()}`,
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
    if (!reading.reference) {
      this.logger.warn(`${providerKey} callback with no recoverable reference`);
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
      where: { reference: reading.reference },
    })) as IntentRow | null;
    if (!intent) {
      this.logger.warn(`${providerKey} callback for unknown reference ${reading.reference}`);
      return { ok: true };
    }

    // Idempotent: a rail that re-notifies a settled charge changes nothing.
    if (intent.status !== "PENDING") return { ok: true };
    if (reading.outcome === "PENDING") return { ok: true };

    // Logged in the SAME append-only gateway_event table as Paystack and Stripe:
    // one place answers "what did a rail tell us, and when", whatever the rail.
    await this.events.record({
      schoolId: intent.schoolId,
      gateway: intent.provider as "MPESA" | "MTN_MOMO" | "AIRTEL",
      eventType: `mobile_money.${reading.outcome.toLowerCase()}`,
      reference: reading.reference,
      payload: body,
    });

    if (reading.outcome === "FAILED") {
      await this.db.runAsTenant({ schoolId: intent.schoolId, userId: intent.payerId ?? SYSTEM_ACTOR_ID }, (tx) =>
        tx.mobileMoneyIntent.update({
          where: { id: intent.id },
          data: { status: "FAILED", failureReason: reading.failureReason ?? "Payment was not completed" },
        }),
      );
      return { ok: true };
    }

    // SUCCEEDED. Credit OUR recorded amount through the one settlement path, which
    // is itself idempotent on the reference — so a callback racing the
    // reconciliation sweep posts once, not twice.
    const outcome = await this.settlement.applyOnlinePayment({
      schoolId: intent.schoolId,
      invoiceId: intent.invoiceId,
      creditMinor: intent.amountMinor,
      chargedMinor: intent.amountMinor,
      reference: intent.reference,
      payerId: intent.payerId ?? undefined,
      note: `Mobile money (${intent.provider})`,
      method: "BANK_TRANSFER",
    });
    await this.db.runAsTenant({ schoolId: intent.schoolId, userId: intent.payerId ?? SYSTEM_ACTOR_ID }, (tx) =>
      tx.mobileMoneyIntent.update({
        where: { id: intent.id },
        data: {
          status: "SUCCEEDED",
          settledAt: new Date(),
          providerRef: reading.providerRef ?? intent.provider,
          ...(outcome === "invoice_missing" ? { failureReason: "Invoice no longer exists" } : {}),
        },
      }),
    );
    return { ok: true };
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
