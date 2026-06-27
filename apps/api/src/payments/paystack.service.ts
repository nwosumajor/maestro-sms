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

  /** Start a hosted Paystack checkout; returns the authorization URL. */
  async initialize(input: {
    email: string;
    amountMinor: number;
    reference: string;
    metadata: Record<string, unknown>;
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
