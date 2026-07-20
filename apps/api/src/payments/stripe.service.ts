// =============================================================================
// StripeService — shared Stripe client (no SDK; fetch + node:crypto)
// =============================================================================
// The USD counterpart to PaystackService: hosted Checkout Sessions for
// school->platform subscription billing in dollars (ENTERPRISE is USD-only;
// other tiers may also be paid in USD by international schools). Mirrors the
// Paystack posture exactly: fetch-only (no SDK), signature-verified webhook,
// and a clean 503 / null when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are
// unset — never a crash. Metadata carries `kind` so the webhook dispatches the
// same way the Paystack one does.
// =============================================================================

import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";

const STRIPE = "https://api.stripe.com";
/** Reject webhook timestamps older than this (replay protection). */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** The slice of a Stripe webhook event we consume. */
export interface StripeEvent {
  type: string;
  data: {
    object: {
      /** Our payment reference (set as client_reference_id at session create). */
      client_reference_id?: string;
      amount_total?: number;
      currency?: string;
      payment_status?: string;
      metadata?: Record<string, string>;
      /** charge.dispute.* events only: the object is a DISPUTE — `id` is the
       *  dispute id (dp_…), `charge` the disputed charge (ch_…, fetched via
       *  getCharge for its metadata), `reason`/`status` Stripe's strings,
       *  `evidence_details.due_by` the unix-seconds evidence deadline. */
      id?: string;
      amount?: number;
      reason?: string;
      status?: string;
      charge?: string;
      evidence_details?: { due_by?: number };
    };
  };
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger("Stripe");

  isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  private secret(): string {
    const s = process.env.STRIPE_SECRET_KEY;
    if (!s) throw new ServiceUnavailableException("USD payments are not configured");
    return s;
  }

  /** Start a hosted Stripe Checkout session; returns the payment URL. */
  async createCheckoutSession(input: {
    email: string;
    amountMinor: number; // cents
    reference: string;
    description: string;
    metadata: Record<string, string>;
  }): Promise<{ authorizationUrl: string }> {
    const secret = this.secret();
    const base = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
    // Stripe's API is form-encoded; bracket syntax expresses the nested params.
    const params = new URLSearchParams({
      mode: "payment",
      client_reference_id: input.reference,
      customer_email: input.email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": input.description,
      success_url: `${base}/billing?paid=1`,
      cancel_url: `${base}/billing?canceled=1`,
    });
    for (const [k, v] of Object.entries(input.metadata)) {
      params.set(`metadata[${k}]`, v);
      // ALSO stamp the PaymentIntent: session metadata never reaches the
      // Charge, and a chargeback webhook only carries the charge — without
      // this, a dispute could never be traced back to a school.
      params.set(`payment_intent_data[metadata][${k}]`, v);
    }
    params.set(`payment_intent_data[metadata][reference]`, input.reference);

    const res = await fetch(`${STRIPE}/v1/checkout/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      this.logger.error(`Stripe session create failed: ${res.status}`);
      throw new ServiceUnavailableException("Payment provider error");
    }
    const json = (await res.json()) as { url: string };
    return { authorizationUrl: json.url };
  }

  /**
   * Fetch a charge (dispute handling: the dispute event carries only the
   * charge id; the charge's metadata — copied from the PaymentIntent we
   * stamped at checkout — identifies the school/kind/reference). Best-effort:
   * null when unconfigured or the fetch fails, never a throw.
   */
  async getCharge(
    chargeId: string,
  ): Promise<{ metadata: Record<string, string>; amount?: number; currency?: string } | null> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return null;
    try {
      const res = await fetch(`${STRIPE}/v1/charges/${encodeURIComponent(chargeId)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) {
        this.logger.warn(`Stripe charge fetch failed: ${res.status} (${chargeId})`);
        return null;
      }
      const json = (await res.json()) as { metadata?: Record<string, string>; amount?: number; currency?: string };
      return { metadata: json.metadata ?? {}, amount: json.amount, currency: json.currency };
    } catch (err) {
      this.logger.warn(`Stripe charge fetch error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Verify a Stripe webhook signature (`Stripe-Signature: t=…,v1=…`) against the
   * raw body: HMAC-SHA256 of `${t}.${rawBody}` with STRIPE_WEBHOOK_SECRET.
   * Returns the parsed event, or null when the gateway is disabled / no body.
   * THROWS on a present-but-bad signature or a stale timestamp.
   */
  verifyWebhook(rawBody: Buffer | undefined, signatureHeader: string | undefined): StripeEvent | null {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !rawBody) return null; // disabled / nothing to verify
    if (!signatureHeader) throw new UnauthorizedException("Missing signature");

    const parts = new Map(
      signatureHeader.split(",").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i).trim(), p.slice(i + 1)] as const;
      }),
    );
    const t = parts.get("t");
    const v1 = parts.get("v1");
    if (!t || !v1) throw new UnauthorizedException("Bad signature");

    const age = Math.abs(Date.now() / 1000 - Number(t));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      throw new UnauthorizedException("Stale signature");
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${t}.${rawBody.toString("utf8")}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Bad signature");
    }
    return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
  }
}
