// =============================================================================
// StripeService — shared Stripe client (no SDK; fetch + node:crypto)
// =============================================================================
// The USD counterpart to PaystackService: hosted Checkout Sessions for
// school->platform subscription billing in dollars (ENTERPRISE presents in USD;
// other tiers may also be paid in USD by international schools). Mirrors the
// Paystack posture exactly: fetch-only (no SDK), signature-verified webhook,
// and a clean 503 / null when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are
// unset — never a crash. Metadata carries `kind` so the webhook dispatches the
// same way the Paystack one does.
// =============================================================================

import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";
import { fetchWithTimeout } from "../common/http";
import { publicWebUrl } from "../common/public-url";

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

  /** Same probe as Paystack's: authenticated, read-only, and it reports the
   *  account's currencies rather than only that the key authenticated. */
  async testConnection(): Promise<{ ok: boolean; detail: string; currencies?: string[]; mode?: "test" | "live" }> {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return { ok: false, detail: "STRIPE_SECRET_KEY is not set." };
    const mode = key.startsWith("sk_live") ? "live" : "test";
    try {
      const res = await fetchWithTimeout("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) {
        return { ok: false, detail: "Stripe rejected the key (401). It is wrong, revoked, or for another account.", mode };
      }
      if (!res.ok) return { ok: false, detail: `Stripe answered ${res.status}.`, mode };
      const body = (await res.json()) as { available?: Array<{ currency?: string }> };
      const currencies = [...new Set((body.available ?? []).map((d) => (d.currency ?? "").toUpperCase()).filter(Boolean))];
      return {
        ok: true,
        mode,
        currencies,
        detail: currencies.length
          ? `Connected. This ${mode} account settles ${currencies.join(", ")}.`
          : `Connected (${mode}), but the account reports no settlement currency yet.`,
      };
    } catch (err) {
      return { ok: false, mode, detail: `Could not reach Stripe: ${(err as Error).message}` };
    }
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
    /** Where the payer lands after checkout (defaults to the billing page —
     *  invoice payments pass the invoice page instead). */
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{ authorizationUrl: string }> {
    const secret = this.secret();
    const base = publicWebUrl();
    // Stripe's API is form-encoded; bracket syntax expresses the nested params.
    const params = new URLSearchParams({
      mode: "payment",
      client_reference_id: input.reference,
      customer_email: input.email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(input.amountMinor),
      "line_items[0][price_data][product_data][name]": input.description,
      success_url: input.successUrl ?? `${base}/billing?paid=1`,
      cancel_url: input.cancelUrl ?? `${base}/billing?canceled=1`,
    });
    for (const [k, v] of Object.entries(input.metadata)) {
      params.set(`metadata[${k}]`, v);
      // ALSO stamp the PaymentIntent: session metadata never reaches the
      // Charge, and a chargeback webhook only carries the charge — without
      // this, a dispute could never be traced back to a school.
      params.set(`payment_intent_data[metadata][${k}]`, v);
    }
    params.set(`payment_intent_data[metadata][reference]`, input.reference);

    const res = await fetchWithTimeout(`${STRIPE}/v1/checkout/sessions`, {
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
      const res = await fetchWithTimeout(`${STRIPE}/v1/charges/${encodeURIComponent(chargeId)}`, {
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
   * Retrieve a Checkout Session by id — the USD verify-on-return path (the payer
   * lands back with ?session_id=…). Returns the payment status, the reference we
   * set (client_reference_id — the SAME string the webhook settles on, so
   * confirming can never double-post), the paid amount and metadata. Best-effort:
   * null when unconfigured or the fetch fails, never a throw.
   */
  async retrieveCheckoutSession(
    sessionId: string,
  ): Promise<{ paymentStatus: string; clientReferenceId: string; amountTotal: number; currency: string; metadata: Record<string, string> } | null> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return null;
    try {
      const res = await fetchWithTimeout(`${STRIPE}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!res.ok) {
        this.logger.warn(`Stripe session fetch failed: ${res.status} (${sessionId})`);
        return null;
      }
      const j = (await res.json()) as { payment_status?: string; client_reference_id?: string; amount_total?: number; currency?: string; metadata?: Record<string, string> };
      return {
        paymentStatus: j.payment_status ?? "",
        clientReferenceId: j.client_reference_id ?? "",
        amountTotal: j.amount_total ?? 0,
        // Stripe reports currency lower-case; the invoice stores it upper.
        currency: (j.currency ?? "").toUpperCase(),
        metadata: j.metadata ?? {},
      };
    } catch (err) {
      this.logger.warn(`Stripe session fetch error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * List PAID checkout sessions created since `from` — the USD reconciliation
   * source (layer 2). Paginated in bounded pages (max 10 × 100 = 1000 sessions
   * per sweep window; overlapping windows are safe — settlement is idempotent on
   * the reference). One list call per page, never per-invoice. Best-effort: [].
   */
  async listRecentPaidSessions(from: Date): Promise<Array<{ reference: string; amountMinor: number; currency: string; metadata: Record<string, string> }>> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return [];
    const out: Array<{ reference: string; amountMinor: number; currency: string; metadata: Record<string, string> }> = [];
    const createdGte = Math.floor(from.getTime() / 1000);
    let startingAfter: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ "created[gte]": String(createdGte), limit: "100" });
      if (startingAfter) params.set("starting_after", startingAfter);
      let json: { data?: Array<{ id: string; payment_status?: string; client_reference_id?: string; amount_total?: number; currency?: string; metadata?: Record<string, string> }>; has_more?: boolean };
      try {
        const res = await fetchWithTimeout(`${STRIPE}/v1/checkout/sessions?${params.toString()}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (!res.ok) {
          this.logger.warn(`Stripe session list failed: ${res.status}`);
          break;
        }
        json = (await res.json()) as typeof json;
      } catch (err) {
        this.logger.warn(`Stripe session list error: ${(err as Error).message}`);
        break;
      }
      const data = json.data ?? [];
      for (const s of data) {
        if (s.payment_status === "paid" && s.client_reference_id) {
          out.push({
            reference: s.client_reference_id,
            amountMinor: s.amount_total ?? 0,
            // UPPERCASED: Stripe reports currency in lower case ("usd"), and the
            // invoice stores it upper. Comparing them raw never matches, so the
            // currency guard would reject every Stripe settlement.
            currency: (s.currency ?? "").toUpperCase(),
            metadata: s.metadata ?? {},
          });
        }
      }
      if (!json.has_more || data.length === 0) break;
      startingAfter = data[data.length - 1].id;
    }
    return out;
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

    // EVERY v1, not just one. During a webhook-secret rotation Stripe signs the
    // event with BOTH secrets and sends `t=…,v1=<new>,v1=<old>`. Reading the
    // header into a Map keeps only the LAST v1, so if our current secret produced
    // the first one, verification fails for the whole rotation window — every
    // paid invoice in it goes uncredited. Accept the event if ANY v1 matches.
    const pairs = signatureHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1)] as const;
    });
    const t = pairs.find(([k]) => k === "t")?.[1];
    const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || signatures.length === 0) throw new UnauthorizedException("Bad signature");

    const age = Math.abs(Date.now() / 1000 - Number(t));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      throw new UnauthorizedException("Stale signature");
    }

    // HMAC the BYTES. Round-tripping the body through a utf8 string would corrupt
    // any byte sequence that is not valid utf8, and the signature is over what
    // Stripe sent, not over what survives a decode.
    const expected = crypto
      .createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]))
      .digest("hex");
    const a = Buffer.from(expected);
    const ok = signatures.some((sig) => {
      const b = Buffer.from(sig);
      // Length-guarded: timingSafeEqual THROWS on a length mismatch rather than
      // returning false, so a short signature would 500 instead of 401.
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!ok) throw new UnauthorizedException("Bad signature");
    return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
  }
}
