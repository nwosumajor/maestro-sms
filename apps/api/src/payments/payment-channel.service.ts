// =============================================================================
// PaymentChannelService — which rails the platform will START a charge on
// =============================================================================
// Same posture as PlatformFeeService / PlanPricingService: the GLOBAL
// `payment_channel_config` row (RLS-exempt, SELECT-only for the app role —
// rls/89), a short TTL cache with Redis fan-out invalidation, and privileged
// writes from the operator screen (step-up gated at the controller, audited).
//
// THE RULE THIS SERVICE EXISTS TO ENFORCE, AND THE LIMIT OF IT:
//
//   assertEnabled() is called from the "start a payment" paths ONLY.
//
// It must never be called from a webhook, a verify-on-return, the
// reconciliation sweep or the mobile-money recovery sweep. Those handle money
// that has ALREADY left a payer's account, and they must keep settling every
// channel for ever — including one switched off years ago. A parent who paid by
// Stripe an hour before the operator turned Stripe off must still have their
// invoice credited. Turning off a rail must never turn off the ledger.
// =============================================================================

import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit,
} from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  CHANNEL_LABELS,
  DEFAULT_ENABLED_CHANNELS,
  currencyIsChargeable,
  normaliseChannels,
  pickCardRail,
  type PaymentChannel,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { RedisPubSubService } from "../common/redis-pubsub.service";
import { PaystackService } from "./paystack.service";
import { StripeService } from "./stripe.service";

const CACHE_TTL_MS = 60_000;
const CONFIG_ID = "default";

/** The slice of a persisted health reading this service reads back. Mirrors
 *  `ChannelHealth` in payment-health.service.ts without importing it — that
 *  module depends on this one, and the reverse would be a cycle. */
interface StoredHealth {
  ok: boolean;
  detail?: string;
  /** Currencies the gateway ACCOUNT can settle. Absent = unknown, and unknown
   *  must never block a payment that might have worked. */
  currencies?: string[];
}
const INVALIDATE_CHANNEL = "payment-channels:invalidate";

/** A school that would have no way to take money under a proposed change. */
export interface StrandedSchool {
  id: string;
  name: string;
  currency: string;
}

/** Whether a rail is switched on, and whether it could actually take a payment. */
export interface ChannelReadiness {
  channel: PaymentChannel;
  enabled: boolean;
  /** Credentials present. A channel can be ON and unusable — that is the point. */
  configured: boolean;
  /** What to set to make it usable, for the operator who just switched it on. */
  missing: string | null;
}

@Injectable()
export class PaymentChannelService implements OnModuleInit {
  private cache: { at: number; enabled: PaymentChannel[] } | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly paystack: PaystackService,
    private readonly stripe: StripeService,
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  /**
   * CAN A PAYER PAY, right now, in this currency? Answered BEFORE the click.
   *
   * A checkout button that starts a payment which cannot succeed is the worst
   * of the options: the payer has committed, waited, and been failed. This
   * composes everything the platform already knows — is a rail switched on, is
   * its credential present, did the last daily check pass, and can any enabled
   * rail settle THIS currency — into one answer the page can act on.
   *
   * PAYER-SAFE BY CONSTRUCTION. It returns a boolean and a sentence written for
   * a parent. It must never leak what testConnection() knows: no gateway status
   * codes, no account currencies, no test-vs-live, nothing about the platform's
   * own posture. The person reading this cannot act on any of that, and it is
   * not theirs to see.
   */
  async availabilityFor(currency: string): Promise<{ available: boolean; reason: string | null }> {
    const enabled = await this.enabled();
    const rail = pickCardRail(currency, enabled);
    if (!rail) {
      return {
        available: false,
        reason: `Online card payment in ${(currency || "NGN").toUpperCase()} is not available yet. Please ask your school for another way to pay.`,
      };
    }
    const ready = this.readiness(enabled).find((r) => r.channel === rail);
    if (!ready?.configured) {
      // Deliberately the same sentence as a rail that is simply down: a payer
      // does not need to know whether a key is missing or wrong, and saying so
      // would tell them something about the platform they cannot use.
      return { available: false, reason: "Online card payment is temporarily unavailable. Please try again later." };
    }
    // The daily check's last reading lives on the SAME row this service already
    // reads, so asking for it costs nothing and needs no extra dependency.
    const health = await this.lastHealth();
    if (health[rail]?.ok === false) {
      return { available: false, reason: "Online card payment is temporarily unavailable. Please try again later." };
    }
    // CAN THE ACCOUNT SETTLE THIS CURRENCY? A different question from whether
    // the RAIL supports it, and the only one that decides if a charge works.
    // Paystack settles USD as a product; an account not enabled for USD refuses
    // with a 403 that surfaced as "Payment provider error" — after the payer
    // had already committed. The probe reported the account's currencies all
    // along; nothing read them.
    //
    // Absent list = unknown, and unknown must not block a payment that might
    // have worked. Only a POSITIVE list that excludes this currency refuses.
    const accountCurrencies = health[rail]?.currencies;
    const code = (currency || "NGN").toUpperCase();
    if (accountCurrencies?.length && !accountCurrencies.includes(code)) {
      return {
        available: false,
        reason: `Online card payment in ${code} is not available yet. Please ask your school for another way to pay.`,
      };
    }
    return { available: true, reason: null };
  }

  /**
   * The same question, phrased for the platform's OWN billing rather than a
   * parent: can a school be charged in `currency` right now, and if not, why —
   * in terms an operator can act on.
   *
   * Split from `availabilityFor` deliberately. That one is read by parents and
   * is vague on purpose (a payer must not learn whether a key is missing or an
   * account is unverified). This one is read by school leadership and the
   * operator, who need to know that ENTERPRISE cannot be bought because the
   * gateway account is not enabled for USD — because that is a thing somebody
   * can go and fix.
   */
  async billingAvailabilityFor(currency: string): Promise<{ available: boolean; reason: string | null }> {
    const code = (currency || "NGN").toUpperCase();
    const enabled = await this.enabled();
    const rail = pickCardRail(code, enabled);
    if (!rail) {
      return {
        available: false,
        reason: `No payment channel is switched on that can charge in ${code}.`,
      };
    }
    const ready = this.readiness(enabled).find((r) => r.channel === rail);
    if (!ready?.configured) {
      return { available: false, reason: `${rail} is switched on but not configured (${ready?.missing ?? "missing credentials"}).` };
    }
    const health = await this.lastHealth();
    if (health[rail]?.ok === false) {
      return { available: false, reason: `${rail} is failing its health check: ${health[rail]?.detail ?? "unknown"}` };
    }
    const accountCurrencies = health[rail]?.currencies;
    if (accountCurrencies?.length && !accountCurrencies.includes(code)) {
      return {
        available: false,
        reason:
          `The ${rail} account is not enabled for ${code} — it settles ${accountCurrencies.join(", ")}. ` +
          `Enable ${code} on the account, or switch on a channel that can settle it.`,
      };
    }
    return { available: true, reason: null };
  }

  /**
   * PROVE a rail works, by talking to it.
   *
   * `readiness()` answers "is a credential present". This answers "does that
   * credential actually work", which is a different and harder question: a key
   * can be a typo, revoked, for another account, or a test key in a live
   * deployment, and every one of those looks identical until a parent tries to
   * pay. Only a real call to the gateway can tell them apart.
   *
   * Mobile money is reported as unverifiable rather than guessed at: its
   * providers have no cheap read-only probe, and claiming "ok" from a key's
   * mere presence is exactly the false assurance this method exists to remove.
   */
  async testConnection(channel: PaymentChannel): Promise<{
    channel: PaymentChannel;
    ok: boolean;
    detail: string;
    currencies?: string[];
    mode?: "test" | "live";
  }> {
    if (channel === "PAYSTACK" || channel === "BANK_TRANSFER") {
      const r = await this.paystack.testConnection();
      return {
        channel,
        ...r,
        detail:
          channel === "BANK_TRANSFER" && r.ok
            ? `${r.detail} Dedicated accounts use this same Paystack account.`
            : r.detail,
      };
    }
    if (channel === "STRIPE") return { channel, ...(await this.stripe.testConnection()) };
    return {
      channel,
      ok: false,
      detail:
        "Mobile money cannot be tested from here — the rails have no read-only probe. " +
        "Confirm it with a sandbox charge on the provider before switching it on for schools.",
    };
  }

  /**
   * Is each rail switched on, and could it actually take a payment?
   *
   * TWO INDEPENDENT THINGS, and conflating them is how a rail gets switched on
   * and quietly serves nobody. The toggle is a commercial decision; credentials
   * are a deployment fact. An operator who enables mobile money in an
   * environment with no M-Pesa keys gets a rail that is "on" and refuses every
   * payer — and the first report of it comes from a parent.
   *
   * Read from the environment rather than injecting the rail services: this
   * asks a deployment question, and coupling the switchboard to every gateway
   * client to answer it would drag their construction into a config read.
   */
  readiness(enabled: PaymentChannel[]): ChannelReadiness[] {
    const has = (...keys: string[]) => keys.every((k) => Boolean(process.env[k]));
    const mobileMoneyReady =
      has("MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY") ||
      has("MTN_MOMO_SUBSCRIPTION_KEY", "MTN_MOMO_API_USER", "MTN_MOMO_API_KEY") ||
      has("AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET");

    const rows: Array<[PaymentChannel, boolean, string]> = [
      ["PAYSTACK", has("PAYSTACK_SECRET_KEY"), "PAYSTACK_SECRET_KEY"],
      ["STRIPE", has("STRIPE_SECRET_KEY"), "STRIPE_SECRET_KEY"],
      // Any ONE rail configured is enough — coverage then decides per school.
      ["MOBILE_MONEY", mobileMoneyReady, "credentials for at least one of M-Pesa, MTN MoMo or Airtel"],
      // Dedicated NUBANs are Paystack accounts. PAYSTACK_DEDICATED_BANK is a
      // tuning knob with a default, NOT a requirement.
      ["BANK_TRANSFER", has("PAYSTACK_SECRET_KEY"), "PAYSTACK_SECRET_KEY"],
    ];
    return rows.map(([channel, configured, missing]) => ({
      channel,
      enabled: enabled.includes(channel),
      configured,
      missing: configured ? null : missing,
    }));
  }

  onModuleInit(): void {
    this.pubsub?.subscribe(INVALIDATE_CHANNEL, () => {
      this.cache = null;
    });
  }

  /** The rails currently switched on. Missing/empty row ⇒ the startup default. */
  async enabled(): Promise<PaymentChannel[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.enabled;
    // Global read, no tenant context (RLS SELECT policy is USING(true) — rls/89).
    const row = await prisma.paymentChannelConfigRow.findFirst({ where: { id: CONFIG_ID } });
    const parsed = normaliseChannels(row?.enabled);
    const enabled = parsed.length > 0 ? parsed : DEFAULT_ENABLED_CHANNELS;
    this.cache = { at: now, enabled };
    return enabled;
  }

  /** Last health reading, from the config row. `{}` when never checked — which
   *  is treated as "no reason to doubt it", not as a failure: a platform that
   *  has not run the sweep yet must not refuse every payment. */
  private async lastHealth(): Promise<Partial<Record<PaymentChannel, StoredHealth>>> {
    const row = await prisma.paymentChannelConfigRow.findFirst({ where: { id: CONFIG_ID } });
    return ((row?.health as Partial<Record<PaymentChannel, StoredHealth>> | null) ?? {});
  }

  async isEnabled(channel: PaymentChannel): Promise<boolean> {
    return (await this.enabled()).includes(channel);
  }

  /**
   * Refuse to START a payment on a channel that is switched off.
   *
   * 503, not 400: the request was valid and the platform is temporarily unable
   * to serve it — which is also what a payer's client should retry against
   * later. The message is the "coming soon" wording, because the person reading
   * it is a parent or a school owner, not an engineer, and a rail the platform
   * has not funded yet is a roadmap item rather than a fault.
   */
  async assertEnabled(channel: PaymentChannel): Promise<void> {
    if (await this.isEnabled(channel)) return;
    throw new ServiceUnavailableException(CHANNEL_LABELS[channel].comingSoon);
  }

  /**
   * Which LIVE schools a proposed set of channels would leave unable to charge.
   *
   * The operator needs this BEFORE flipping a switch, not after a parent fails
   * to pay. Paystack settles five of the platform's currencies — Nigeria,
   * Ghana, Kenya, South Africa and anywhere billing in USD — and nothing else
   * in the 37-country catalogue, so turning the other rails off while a
   * Senegalese or Ugandan school is live strands that school completely.
   *
   * Uses the privileged client because it is a cross-tenant question. Returns
   * [] when unavailable rather than throwing: an operator must still be able to
   * read and set the config in an environment without it, they simply get no
   * impact preview, and the caller says so.
   */
  async strandedBy(enabled: PaymentChannel[]): Promise<StrandedSchool[]> {
    const client = this.privileged.client;
    if (!client) return [];
    const schools = await client.school.findMany({
      where: { isPlatform: false, status: "ACTIVE" },
      select: { id: true, name: true, currency: true },
    });
    return schools
      // A null currency means the platform's home country (NGN) — see the
      // region model in CLAUDE.md; treat it as such rather than as unknown.
      .map((s) => ({ id: s.id, name: s.name, currency: (s.currency ?? "NGN").toUpperCase() }))
      .filter((s) => !currencyIsChargeable(s.currency, enabled));
  }

  /**
   * super_admin: set the enabled rails. Privileged write, audited, cache dropped.
   *
   * `force` exists because "you would strand a school" is a warning an operator
   * may legitimately overrule — during an outage on a rail, say — but never one
   * they should be able to walk past without seeing.
   */
  async update(
    p: Principal,
    input: { enabled: PaymentChannel[]; note?: string | null; force?: boolean },
  ): Promise<{ enabled: PaymentChannel[]; stranded: StrandedSchool[]; unconfigured: PaymentChannel[] }> {
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Payment channel management requires the privileged database configuration");
    }
    const enabled = normaliseChannels(input.enabled);
    if (enabled.length === 0) {
      // Not a validation nicety: an empty set stops every payment on the
      // platform, and nothing else in the system would report why.
      throw new BadRequestException("At least one payment channel must stay enabled — otherwise nobody can pay at all.");
    }

    // Enabling a rail with no credentials is not refused — it is a legitimate
    // step when the keys land minutes later — but it IS reported, so nobody
    // discovers it from a parent who could not pay.
    const unconfigured = this.readiness(enabled)
      .filter((r) => r.enabled && !r.configured)
      .map((r) => r.channel);

    const stranded = await this.strandedBy(enabled);
    if (stranded.length > 0 && !input.force) {
      throw new BadRequestException(
        `This would leave ${stranded.length} live school(s) with no way to take payment: ` +
          `${stranded.map((s) => `${s.name} (${s.currency})`).join(", ")}. ` +
          `Re-send with force:true to apply it anyway.`,
      );
    }

    await client.paymentChannelConfigRow.upsert({
      where: { id: CONFIG_ID },
      update: { enabled: enabled as unknown as object, note: input.note ?? null },
      create: { id: CONFIG_ID, enabled: enabled as unknown as object, note: input.note ?? null },
    });
    this.cache = null;
    this.pubsub?.publish(INVALIDATE_CHANNEL, { at: Date.now() });

    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.payment_channels.update",
          entity: "payment_channel_config",
          entityId: CONFIG_ID,
          schoolId: p.schoolId,
          // The stranded list is recorded too: if it was overruled, the record
          // says who did it and what they were told at the time.
          metadata: {
            enabled,
            forced: Boolean(input.force),
            strandedCount: stranded.length,
            // Recorded so "we turned it on weeks ago" can be checked against
            // whether it could ever have worked.
            unconfigured,
          },
        },
        tx,
      ),
    );
    return { enabled, stranded, unconfigured };
  }
}
