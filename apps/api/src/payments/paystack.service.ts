// =============================================================================
// PaystackService — shared Paystack client (no SDK; fetch + node:crypto)
// =============================================================================
// The single place that talks to Paystack, used by BOTH parent->school Fees
// payments and school->platform subscription billing. Paystack allows ONE webhook
// URL per account, so the verified event is dispatched by `metadata.kind`
// downstream — this service only initializes transactions and verifies the HMAC.
// Requires PAYSTACK_SECRET_KEY + outbound network; UNSET => callers get a 503 on
// initialize and `verify` returns null (disabled), never a crash.
// =============================================================================

import { PAYSTACK_CURRENCIES, paystackCanSettle } from "@sms/types";
import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";

const PAYSTACK = "https://api.paystack.co";

/** Bank lists change a few times a year; a settlement form does not warrant a
 *  gateway round trip per render. */
const BANK_CACHE_MS = 60 * 60 * 1000;

/** The slice of a Paystack webhook event we consume. */
export interface PaystackEvent {
  event: string;
  data: {
    amount: number;
    /** ISO currency of the charge (e.g. "NGN"). */
    currency?: string;
    reference: string;
    metadata?: Record<string, unknown>;
    /** Payment channel — "dedicated_nuban" for virtual-account bank transfers
     *  (those carry NO metadata; the customer code is the mapping key). */
    channel?: string;
    /** Card authorization (present on charge.success) — `authorization_code`
     *  with `reusable: true` enables saved-card recurring charges. */
    authorization?: { authorization_code?: string; reusable?: boolean; last4?: string; card_type?: string };
    customer?: { customer_code?: string; email?: string };
    /** charge.dispute.* events only: `data` is the DISPUTE, not a charge —
     *  `id` is the gateway dispute id, `transaction` the disputed charge
     *  (whose metadata carries our schoolId), `due_at` the evidence deadline,
     *  `resolution` the outcome on charge.dispute.resolve ("declined" = the
     *  dispute was rejected and the merchant keeps the money). */
    id?: number | string;
    status?: string;
    resolution?: string | null;
    category?: string | null;
    due_at?: string | null;
    transaction?: { reference?: string; amount?: number; metadata?: Record<string, unknown> | null };
  };
}

/**
 * A gateway amount is an integer count of minor units. A fractional one is either
 * rejected outright or silently truncated, and truncation is a charge that does
 * not match the invoice. Asserted rather than rounded — rounding at the rail is
 * what overcharged a payer on the M-Pesa rail.
 */
function assertPaystackCurrency(currency: string): string {
  const c = (currency ?? "").toUpperCase();
  if (!paystackCanSettle(c)) {
    // REFUSED, not defaulted. Falling back to the account currency is what
    // charged a Ghanaian parent NGN 5,000 for a GHS 5,000 invoice. Mobile money
    // covers most of the countries this rejects, so the message says so.
    throw new ServiceUnavailableException(
      `Card payments are not available in ${c} — this school's card rail settles ` +
        `${PAYSTACK_CURRENCIES.join(", ")}. Use mobile money, or ask the operator to enable ${c}.`,
    );
  }
  return c;
}

function assertMinorInteger(amountMinor: number, rail: string): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new ServiceUnavailableException(`${rail} needs a whole number of minor units`);
  }
  return amountMinor;
}

@Injectable()
export class PaystackService {
  private readonly logger = new Logger("Paystack");
  private readonly bankCache = new Map<string, { at: number; banks: Array<{ code: string; name: string }> }>();
  /** What THIS merchant account can actually charge — see `merchantCurrencies`. */
  private currencyCache: { at: number; currencies: string[] } | null = null;

  isConfigured(): boolean {
    return !!process.env.PAYSTACK_SECRET_KEY;
  }

  private secret(): string {
    const s = process.env.PAYSTACK_SECRET_KEY;
    if (!s) throw new ServiceUnavailableException("Online payments are not configured");
    return s;
  }

  /**
   * Prove the credential actually works — not merely that it is present.
   *
   * A key can be present and useless: a typo, a revoked key, a TEST key in a
   * live deployment, or a key for a different account entirely. Every one of
   * those looks identical to a working setup until a parent tries to pay.
   *
   * `GET /balance` is the right probe: authenticated, read-only, cheap, and it
   * returns the account's CURRENCIES — so this can answer the question that
   * actually matters ("can this account settle what our schools are billed
   * in?") rather than just "did the key authenticate".
   *
   * Never throws. A connectivity check that throws is a check nobody can call
   * from a UI without wrapping it, and the failure IS the answer here.
   */
  async testConnection(): Promise<{ ok: boolean; detail: string; currencies?: string[]; mode?: "test" | "live" }> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return { ok: false, detail: "PAYSTACK_SECRET_KEY is not set." };
    const mode = key.startsWith("sk_live") ? "live" : "test";
    try {
      const res = await fetch(`${PAYSTACK}/balance`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) {
        return { ok: false, detail: "Paystack rejected the key (401). It is wrong, revoked, or for another account.", mode };
      }
      if (!res.ok) {
        return { ok: false, detail: `Paystack answered ${res.status}. The key may be valid but the account cannot transact yet.`, mode };
      }
      const body = (await res.json()) as { data?: Array<{ currency?: string }> };
      const currencies = [...new Set((body.data ?? []).map((d) => (d.currency ?? "").toUpperCase()).filter(Boolean))];
      return {
        ok: true,
        mode,
        currencies,
        detail: currencies.length
          ? `Connected. This ${mode} account settles ${currencies.join(", ")}.`
          : `Connected (${mode}), but the account reports no settlement currency yet.`,
      };
    } catch (err) {
      // Timeout or DNS/network — a real answer for an operator staring at a
      // checkout that hangs, and distinct from "the key is wrong".
      return { ok: false, mode, detail: `Could not reach Paystack: ${(err as Error).message}` };
    }
  }

  /** Start a hosted Paystack checkout; returns the authorization URL.
   *  With `subaccount` set, Paystack SPLITS settlement to that subaccount's bank
   *  (parent fees → the school's own account); `bearer` says who pays Paystack's
   *  transaction fee ("subaccount" = the school, on their own collections).
   *  `transactionChargeMinor` is the PLATFORM's flat take on THIS charge (kobo)
   *  — it overrides the subaccount's percentage_charge and is retained by the
   *  main (platform) account before the split settles to the school. */
  async initialize(input: {
    email: string;
    amountMinor: number;
    reference: string;
    metadata: Record<string, unknown>;
    subaccount?: string;
    bearer?: "account" | "subaccount";
    transactionChargeMinor?: number;
    /** ISO 4217. Never defaulted — see the body below. */
    currency: string;
    /** Where Paystack sends the payer after the charge (it appends
     *  ?reference=… — the verify-on-return hook). Falls back to the
     *  dashboard-configured URL when unset. */
    callbackUrl?: string;
  }): Promise<{ authorizationUrl: string }> {
    const secret = this.secret();
    const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        amount: assertMinorInteger(input.amountMinor, "Paystack"),
        // NAMED, ALWAYS. Omitting it charges in the ACCOUNT's currency, so a GHS
        // 5,000 invoice became an NGN 5,000 charge — the school underpaid by ~90%
        // with the ledger recording it settled. The caller has already refused a
        // currency this rail cannot settle; this makes sure the rail is told.
        currency: assertPaystackCurrency(input.currency),
        reference: input.reference,
        metadata: input.metadata,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
        ...(input.subaccount ? { subaccount: input.subaccount, bearer: input.bearer ?? "subaccount" } : {}),
        ...(input.subaccount && input.transactionChargeMinor && input.transactionChargeMinor > 0
          ? { transaction_charge: input.transactionChargeMinor }
          : {}),
      }),
    });
    if (!res.ok) {
      // NAME THE REASON WHEN THE RAIL GIVES ONE. "Payment provider error" sends
      // a parent to the school and the school to support, for a condition
      // somebody can fix in a dashboard in a minute. The one that actually
      // happens: the platform's static currency list says Paystack handles GHS,
      // and this particular MERCHANT ACCOUNT does not.
      //
      //     GHS -> 403 {"message":"Currency not supported by merchant"}
      //
      // Verified live. Nothing else in the flow could tell the difference
      // between that and the gateway being down.
      const detail = await res
        .clone()
        .json()
        .then((j) => (j as { message?: string })?.message ?? "")
        .catch(() => "");
      this.logger.error(`Paystack init failed: ${res.status} ${detail}`);
      if (/currency not supported by merchant/i.test(detail)) {
        throw new ServiceUnavailableException(
          `This Paystack account cannot charge in ${input.currency.toUpperCase()}. Enable that currency on the ` +
            "Paystack dashboard, or collect this payment by mobile money.",
        );
      }
      throw new ServiceUnavailableException(detail ? `Payment provider error: ${detail}` : "Payment provider error");
    }
    const json = (await res.json()) as { data: { authorization_url: string } };
    return { authorizationUrl: json.data.authorization_url };
  }

  /**
   * Charge a SAVED card authorization (auto-renew). Synchronous: Paystack
   * returns the charge outcome directly, and the account webhook ALSO fires —
   * the caller's idempotency-on-reference makes the double delivery safe.
   */
  async chargeAuthorization(input: {
    email: string;
    amountMinor: number;
    reference: string;
    authorizationCode: string;
    metadata: Record<string, unknown>;
    currency: string;
  }): Promise<{ ok: boolean; status?: string }> {
    const secret = this.secret();
    const res = await fetch(`${PAYSTACK}/transaction/charge_authorization`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        amount: assertMinorInteger(input.amountMinor, "Paystack"),
        currency: assertPaystackCurrency(input.currency),
        reference: input.reference,
        authorization_code: input.authorizationCode,
        metadata: input.metadata,
      }),
    });
    if (!res.ok) {
      this.logger.warn(`Paystack charge_authorization failed: ${res.status}`);
      return { ok: false, status: String(res.status) };
    }
    const json = (await res.json()) as { data?: { status?: string } };
    return { ok: json.data?.status === "success", status: json.data?.status };
  }

  /**
   * The banks Paystack can actually settle to, for a country.
   *
   * This was a hard-coded list of TEN banks in the web form, which is both stale
   * and a revenue block: Nigeria has ~100 settling institutions and the fintechs
   * a small school is most likely to bank with — Kuda, Opay, Moniepoint, PalmPay
   * — were none of them. A school that cannot find its bank cannot set up direct
   * settlement, and every fee it then collects pools at the platform instead.
   *
   * Cached for an hour: the list changes a few times a year, and a settlement
   * form is not worth a gateway round trip per render.
   */
  async listBanks(country = "nigeria"): Promise<Array<{ code: string; name: string }>> {
    const hit = this.bankCache.get(country);
    if (hit && Date.now() - hit.at < BANK_CACHE_MS) return hit.banks;

    const res = await fetch(`${PAYSTACK}/bank?country=${encodeURIComponent(country)}&perPage=200`, {
      headers: { Authorization: `Bearer ${this.secret()}` },
    });
    if (!res.ok) {
      this.logger.warn(`Paystack bank list failed: ${res.status}`);
      // Serve a stale list rather than an empty picker — an hour-old bank list
      // is correct, and an empty one strands the school for no reason.
      if (hit) return hit.banks;
      throw new ServiceUnavailableException("Could not load the bank list from the payment provider");
    }
    const json = (await res.json()) as { data?: Array<{ code?: string; name?: string }> };
    const banks = (json.data ?? [])
      .filter((b): b is { code: string; name: string } => Boolean(b.code && b.name))
      .map((b) => ({ code: b.code, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.bankCache.set(country, { at: Date.now(), banks });
    return banks;
  }

  /**
   * Resolve a bank account to the NAME it is held in.
   *
   * THE POINT: creating a subaccount proves the account EXISTS, never that it
   * belongs to the school. A transposed digit that still lands on a valid
   * account at the same bank is accepted silently, and from that moment every
   * parent's fee settles into a stranger's account — permanently, and with the
   * invoice correctly marked PAID at both ends, so nothing in this system ever
   * notices. The only thing that can catch it is a human reading the account
   * name back, which is why this is a separate step the school must confirm.
   *
   * Returns null when the account cannot be resolved, so the caller can say so
   * plainly rather than treating an unverifiable account as verified.
   */
  async resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string } | null> {
    const qs = `account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`;
    const res = await fetch(`${PAYSTACK}/bank/resolve?${qs}`, {
      headers: { Authorization: `Bearer ${this.secret()}` },
    });
    if (!res.ok) {
      // 422 is Paystack's "could not resolve" — a wrong number, not an outage.
      this.logger.warn(`Paystack account resolve failed: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { data?: { account_name?: string } };
    const accountName = json.data?.account_name?.trim();
    return accountName ? { accountName } : null;
  }

  /**
   * The currencies THIS Paystack account is enabled for.
   *
   * `PAYSTACK_CURRENCIES` says what Paystack the company supports. That is a
   * different question from what a given merchant account may charge, and the
   * platform was using the first as though it answered the second. Verified live
   * against a real key:
   *
   *     NGN  200 accepted
   *     GHS  403 Currency not supported by merchant
   *     KES  403 Currency not supported by merchant
   *     ZAR  403 Currency not supported by merchant
   *     USD  403 Currency not supported by merchant
   *
   * So a Ghanaian school's GHS invoice passed `paystackCanSettle`, was routed
   * here, and the parent met a raw gateway refusal at checkout — while the
   * "use mobile money instead" message, which exists for exactly this, never
   * fired because GHS is in the static list.
   *
   * `/balance` reports one row per enabled currency and is the account's own
   * answer. Cached, because it changes when somebody edits a dashboard, not per
   * request. Returns null when it cannot be determined — the caller then falls
   * back to the static list, which is today's behaviour and cannot regress a
   * working school.
   */
  async merchantCurrencies(): Promise<string[] | null> {
    if (this.currencyCache && Date.now() - this.currencyCache.at < BANK_CACHE_MS) {
      return this.currencyCache.currencies;
    }
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(`${PAYSTACK}/balance`, { headers: { Authorization: `Bearer ${this.secret()}` } });
      if (!res.ok) {
        this.logger.warn(`Paystack balance read failed: ${res.status}`);
        return this.currencyCache?.currencies ?? null;
      }
      const json = (await res.json()) as { data?: Array<{ currency?: string }> };
      const currencies = [...new Set((json.data ?? []).map((b) => b.currency?.toUpperCase()).filter((c): c is string => !!c))];
      if (currencies.length === 0) return this.currencyCache?.currencies ?? null;
      this.currencyCache = { at: Date.now(), currencies };
      return currencies;
    } catch (err) {
      this.logger.warn(`Paystack balance read failed: ${String(err)}`);
      return this.currencyCache?.currencies ?? null;
    }
  }

  /**
   * Create a settlement SUBACCOUNT (the school's own bank) for split payments.
   * `percentageCharge` is the PLATFORM's share of each split transaction
   * (PLATFORM_FEES_COMMISSION_PERCENT env, default 0). Returns the subaccount
   * code to stamp on future fee charges.
   */
  async createSubaccount(input: {
    businessName: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<{ subaccountCode: string; bankName: string }> {
    const secret = this.secret();
    const percentageCharge = Number(process.env.PLATFORM_FEES_COMMISSION_PERCENT ?? 0);
    const res = await fetch(`${PAYSTACK}/subaccount`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        business_name: input.businessName,
        settlement_bank: input.bankCode,
        account_number: input.accountNumber,
        percentage_charge: Number.isFinite(percentageCharge) ? percentageCharge : 0,
      }),
    });
    if (!res.ok) {
      this.logger.error(`Paystack subaccount create failed: ${res.status}`);
      throw new ServiceUnavailableException("Could not verify the bank account with the payment provider");
    }
    const json = (await res.json()) as { data: { subaccount_code: string; settlement_bank: string } };
    return { subaccountCode: json.data.subaccount_code, bankName: json.data.settlement_bank };
  }

  /**
   * Create a gateway CUSTOMER (required before a dedicated account can be
   * assigned). Returns the customer code — our webhook lookup key.
   */
  async createCustomer(input: { email: string; firstName: string; lastName: string }): Promise<{ customerCode: string }> {
    const secret = this.secret();
    const res = await fetch(`${PAYSTACK}/customer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, first_name: input.firstName, last_name: input.lastName }),
    });
    if (!res.ok) {
      this.logger.error(`Paystack customer create failed: ${res.status}`);
      throw new ServiceUnavailableException("Payment provider error");
    }
    const json = (await res.json()) as { data: { customer_code: string } };
    return { customerCode: json.data.customer_code };
  }

  /**
   * Assign a DEDICATED NUBAN (virtual bank account) to a customer. Transfers
   * to it raise ordinary charge.success webhooks carrying the customer code —
   * no metadata — which is why StudentVirtualAccount maps code -> student.
   * Bank overridable via PAYSTACK_DEDICATED_BANK (default wema-bank).
   */
  async createDedicatedAccount(customerCode: string): Promise<{ accountNumber: string; bankName: string }> {
    const secret = this.secret();
    const res = await fetch(`${PAYSTACK}/dedicated_account`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: customerCode,
        preferred_bank: process.env.PAYSTACK_DEDICATED_BANK ?? "wema-bank",
      }),
    });
    if (!res.ok) {
      this.logger.error(`Paystack dedicated account create failed: ${res.status}`);
      throw new ServiceUnavailableException("Payment provider error");
    }
    const json = (await res.json()) as { data: { account_number: string; bank: { name: string } } };
    return { accountNumber: json.data.account_number, bankName: json.data.bank.name };
  }

  /**
   * Verify a transaction DIRECTLY against the gateway (the lost-webhook
   * recovery path: called when a payer returns from checkout, and by the
   * reconciliation sweep). Returns the settled charge's facts, or null when
   * unconfigured / not found / not successful — never throws.
   */
  async verifyTransaction(reference: string): Promise<{
    status: string;
    amountMinor: number;
    /** What the payer was ACTUALLY charged in — checked against the invoice
     *  before settlement posts anything. */
    currency: string;
    metadata: Record<string, unknown>;
  } | null> {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return null;
    try {
      const res = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { status?: string; amount?: number; currency?: string; metadata?: Record<string, unknown> | null };
      };
      if (!json.data?.status) return null;
      return {
        status: json.data.status,
        amountMinor: json.data.amount ?? 0,
        currency: (json.data.currency ?? "").toUpperCase(),
        metadata: json.data.metadata ?? {},
      };
    } catch (err) {
      this.logger.warn(`Paystack verify error (${reference}): ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * List successful transactions since `from` (reconciliation sweep). Pages
   * through the gateway's history up to `maxPages` × 100 rows. Best-effort:
   * returns what it could fetch, never throws.
   */
  async listSuccessfulTransactions(
    from: Date,
    maxPages = 10,
  ): Promise<Array<{ reference: string; amountMinor: number; currency: string; metadata: Record<string, unknown> }>> {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return [];
    const out: Array<{ reference: string; amountMinor: number; currency: string; metadata: Record<string, unknown> }> = [];
    try {
      for (let page = 1; page <= maxPages; page++) {
        const url = `${PAYSTACK}/transaction?status=success&perPage=100&page=${page}&from=${encodeURIComponent(from.toISOString())}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
        if (!res.ok) break;
        const json = (await res.json()) as {
          data?: Array<{ reference?: string; amount?: number; currency?: string; metadata?: Record<string, unknown> | null }>;
        };
        const rows = json.data ?? [];
        for (const r of rows) {
          if (r.reference)
            out.push({
              reference: r.reference,
              amountMinor: r.amount ?? 0,
              // Reconciliation posts against an invoice, so it must know what the
              // payer was charged IN — not assume the account default.
              currency: (r.currency ?? "").toUpperCase(),
              metadata: r.metadata ?? {},
            });
        }
        if (rows.length < 100) break;
      }
    } catch (err) {
      this.logger.warn(`Paystack transaction list error: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * Refund (part of) a settled transaction BACK TO THE ORIGINAL CARD. Keyed on
   * the original transaction reference, so money can only ever return to the
   * instrument that paid — never be redirected. Paystack tracks the refundable
   * remainder per transaction, so an accidental double call is rejected there
   * too. Best-effort contract: returns {ok:false} rather than throwing, so the
   * caller can fall back to the manual-return path with an explicit notice.
   */
  async refund(input: { transactionReference: string; amountMinor: number }): Promise<{ ok: boolean; error?: string }> {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return { ok: false, error: "gateway not configured" };
    try {
      const res = await fetch(`${PAYSTACK}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: input.transactionReference, amount: input.amountMinor }),
      });
      if (!res.ok) {
        this.logger.error(`Paystack refund failed: ${res.status} (ref ${input.transactionReference})`);
        return { ok: false, error: `provider ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      this.logger.error(`Paystack refund error: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Verify a webhook's HMAC-SHA512 signature against the raw body. Returns the
   * parsed event, or null when the gateway is disabled / there is no body.
   * THROWS on a present-but-bad signature.
   */
  verify(rawBody: Buffer | undefined, signature: string | undefined): PaystackEvent | null {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret || !rawBody) return null; // disabled / nothing to verify
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    // Constant-time compare so a bad signature can't be brute-forced via timing.
    const expected = Buffer.from(hash);
    const got = signature ? Buffer.from(signature) : Buffer.alloc(0);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
      throw new UnauthorizedException("Bad signature");
    }
    return JSON.parse(rawBody.toString("utf8")) as PaystackEvent;
  }
}
