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
   *  transaction fee ("subaccount" = the school, on their own collections). */
  async initialize(input: {
    email: string;
    amountMinor: number;
    reference: string;
    metadata: Record<string, unknown>;
    subaccount?: string;
    bearer?: "account" | "subaccount";
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
        ...(input.subaccount ? { subaccount: input.subaccount, bearer: input.bearer ?? "subaccount" } : {}),
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
