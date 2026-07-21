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

import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";

const PAYSTACK = "https://api.paystack.co";

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

@Injectable()
export class PaystackService {
  private readonly logger = new Logger("Paystack");

  isConfigured(): boolean {
    return !!process.env.PAYSTACK_SECRET_KEY;
  }

  private secret(): string {
    const s = process.env.PAYSTACK_SECRET_KEY;
    if (!s) throw new ServiceUnavailableException("Online payments are not configured");
    return s;
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
        amount: input.amountMinor,
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
      this.logger.error(`Paystack init failed: ${res.status}`);
      throw new ServiceUnavailableException("Payment provider error");
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
  }): Promise<{ ok: boolean; status?: string }> {
    const secret = this.secret();
    const res = await fetch(`${PAYSTACK}/transaction/charge_authorization`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
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
        data?: { status?: string; amount?: number; metadata?: Record<string, unknown> | null };
      };
      if (!json.data?.status) return null;
      return {
        status: json.data.status,
        amountMinor: json.data.amount ?? 0,
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
  ): Promise<Array<{ reference: string; amountMinor: number; metadata: Record<string, unknown> }>> {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return [];
    const out: Array<{ reference: string; amountMinor: number; metadata: Record<string, unknown> }> = [];
    try {
      for (let page = 1; page <= maxPages; page++) {
        const url = `${PAYSTACK}/transaction?status=success&perPage=100&page=${page}&from=${encodeURIComponent(from.toISOString())}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
        if (!res.ok) break;
        const json = (await res.json()) as {
          data?: Array<{ reference?: string; amount?: number; metadata?: Record<string, unknown> | null }>;
        };
        const rows = json.data ?? [];
        for (const r of rows) {
          if (r.reference) out.push({ reference: r.reference, amountMinor: r.amount ?? 0, metadata: r.metadata ?? {} });
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
