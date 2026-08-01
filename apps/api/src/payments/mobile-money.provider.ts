// =============================================================================
// Mobile-money provider adapters — one interface, one per rail
// =============================================================================
// Every rail implements the SAME three things: am I configured, start a charge,
// interpret a callback. Nothing outside this file knows which rail is in use, so
// adding Airtel or a new country is an adapter and a coverage row — never another
// branch in the service, the controller or the tests.
//
// AMOUNTS GO THROUGH `toMajor`. Daraja wants whole shillings and MTN wants a
// decimal string in the major unit; neither wants our stored minor units. Dividing
// by 100 here would be the same bug the currency work just removed — the CFA franc
// has no subdivision, so `toMajor` asks the currency and not a constant.
// =============================================================================

import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { toMajor, type MobileMoneyProviderKey } from "@sms/types";

/** What a rail is asked to do. Provider-agnostic by construction. */
export interface ChargeRequest {
  /** OUR reference — the idempotency key we will match a callback on. */
  reference: string;
  amountMinor: number;
  currency: string;
  /** Normalised MSISDN (country code, no plus, no trunk zero). */
  msisdn: string;
  /** Shown on the payer's handset. Rails truncate this hard. */
  narrative: string;
  /** Where the rail should notify us. */
  callbackUrl: string;
}

export interface ChargeAck {
  /** The rail's own id for the request, kept for support and reconciliation. */
  providerRef: string | null;
  /** What to tell the payer to do next. */
  instruction: string;
}

/** What a callback body meant, once the adapter has read it. Deliberately small:
 *  amounts are NOT taken from callbacks (see MobileMoneyIntent). */
export interface CallbackReading {
  /** Our reference, recovered from the payload. Null when unrecognisable. */
  reference: string | null;
  outcome: "SUCCEEDED" | "FAILED" | "PENDING";
  providerRef?: string | null;
  failureReason?: string | null;
}

export interface MobileMoneyProvider {
  readonly key: MobileMoneyProviderKey;
  /** False when the platform holds no credentials for this rail. A provider is
   *  DISABLED, never half-working. */
  isConfigured(): boolean;
  charge(req: ChargeRequest): Promise<ChargeAck>;
  readCallback(body: unknown): CallbackReading;
}

/** Pull a nested value without a cast-fest at every call site. */
function at(o: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = o;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

// =============================================================================
// M-Pesa (Safaricom Daraja) — STK Push
// =============================================================================

@Injectable()
export class MpesaProvider implements MobileMoneyProvider {
  readonly key = "MPESA" as const;
  private readonly logger = new Logger("M-Pesa");

  isConfigured(): boolean {
    return !!(
      process.env.MPESA_CONSUMER_KEY &&
      process.env.MPESA_CONSUMER_SECRET &&
      process.env.MPESA_SHORTCODE &&
      process.env.MPESA_PASSKEY
    );
  }

  private base(): string {
    // Sandbox by default: a misconfigured deployment must not charge real money.
    return process.env.MPESA_ENV === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";
  }

  private async token(): Promise<string> {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
    ).toString("base64");
    const res = await fetch(`${this.base()}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new ServiceUnavailableException("M-Pesa authentication failed");
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new ServiceUnavailableException("M-Pesa returned no access token");
    return body.access_token;
  }

  async charge(req: ChargeRequest): Promise<ChargeAck> {
    if (!this.isConfigured()) throw new ServiceUnavailableException("M-Pesa is not configured");
    const shortcode = process.env.MPESA_SHORTCODE!;
    // Daraja's timestamp is yyyyMMddHHmmss and the password is a base64 of
    // shortcode+passkey+timestamp. Both must use the SAME timestamp or it 401s.
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${ts}`).toString("base64");

    // Daraja rejects decimals: the amount is whole shillings. Rounding UP would
    // overcharge, so it rounds to nearest and the ledger is credited with what we
    // actually asked for — the intent records the rounded figure, not the invoice's.
    const amount = Math.round(toMajor(req.amountMinor, req.currency));

    const res = await fetch(`${this.base()}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: req.msisdn,
        PartyB: shortcode,
        PhoneNumber: req.msisdn,
        CallBackURL: req.callbackUrl,
        // Daraja truncates these hard; the reference is what we match a callback on.
        AccountReference: req.reference.slice(0, 12),
        TransactionDesc: req.narrative.slice(0, 13),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.ResponseCode !== "0") {
      this.logger.warn(`STK push refused: ${JSON.stringify(body).slice(0, 300)}`);
      throw new ServiceUnavailableException(
        typeof body.errorMessage === "string" ? body.errorMessage : "M-Pesa refused the request",
      );
    }
    return {
      providerRef: typeof body.CheckoutRequestID === "string" ? body.CheckoutRequestID : null,
      instruction: "Check your phone and enter your M-Pesa PIN to approve the payment.",
    };
  }

  readCallback(body: unknown): CallbackReading {
    const cb = at(body, "Body", "stkCallback");
    const code = at(cb, "ResultCode");
    // Our reference comes back in the metadata we sent, NOT from a trusted field —
    // which is fine, because it is only used to LOOK UP the intent. The amount is
    // read from that intent, never from here.
    const items = at(cb, "CallbackMetadata", "Item");
    let reference: string | null = null;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (at(it, "Name") === "AccountReference") reference = String(at(it, "Value") ?? "") || null;
      }
    }
    const providerRef = typeof at(cb, "CheckoutRequestID") === "string" ? String(at(cb, "CheckoutRequestID")) : null;
    if (code === undefined) return { reference, outcome: "PENDING", providerRef };
    const ok = Number(code) === 0;
    return {
      reference,
      outcome: ok ? "SUCCEEDED" : "FAILED",
      providerRef,
      failureReason: ok ? null : String(at(cb, "ResultDesc") ?? "Payment was not completed"),
    };
  }
}

// =============================================================================
// MTN MoMo — Collections (requesttopay)
// =============================================================================

@Injectable()
export class MtnMomoProvider implements MobileMoneyProvider {
  readonly key = "MTN_MOMO" as const;
  private readonly logger = new Logger("MTN MoMo");

  isConfigured(): boolean {
    return !!(
      process.env.MTN_MOMO_SUBSCRIPTION_KEY &&
      process.env.MTN_MOMO_API_USER &&
      process.env.MTN_MOMO_API_KEY
    );
  }

  private base(): string {
    return process.env.MTN_MOMO_ENV === "production"
      ? "https://proxy.momoapi.mtn.com"
      : "https://sandbox.momodeveloper.mtn.com";
  }

  private target(): string {
    return process.env.MTN_MOMO_ENV === "production" ? process.env.MTN_MOMO_TARGET ?? "production" : "sandbox";
  }

  private async token(): Promise<string> {
    const auth = Buffer.from(`${process.env.MTN_MOMO_API_USER}:${process.env.MTN_MOMO_API_KEY}`).toString("base64");
    const res = await fetch(`${this.base()}/collection/token/`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY!,
      },
    });
    if (!res.ok) throw new ServiceUnavailableException("MTN MoMo authentication failed");
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new ServiceUnavailableException("MTN MoMo returned no access token");
    return body.access_token;
  }

  async charge(req: ChargeRequest): Promise<ChargeAck> {
    if (!this.isConfigured()) throw new ServiceUnavailableException("MTN Mobile Money is not configured");
    // MTN's X-Reference-Id IS the idempotency key and must be a UUID. Ours is a
    // reference string, so it travels in externalId and the UUID is derived —
    // meaning a retry of the same charge is idempotent at MTN's end too.
    const xRef = req.reference.replace(/[^a-f0-9]/gi, "").padEnd(32, "0").slice(0, 32);
    const uuid = `${xRef.slice(0, 8)}-${xRef.slice(8, 12)}-${xRef.slice(12, 16)}-${xRef.slice(16, 20)}-${xRef.slice(20, 32)}`;
    // MoMo takes the MAJOR unit as a string. `toMajor` asks the currency, so a
    // zero-decimal currency (XAF, XOF, RWF, UGX) is not divided by 100.
    const amount = toMajor(req.amountMinor, req.currency).toString();

    const res = await fetch(`${this.base()}/collection/v1_0/requesttopay`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "X-Reference-Id": uuid,
        "X-Target-Environment": this.target(),
        "X-Callback-Url": req.callbackUrl,
        "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: req.currency,
        externalId: req.reference,
        payer: { partyIdType: "MSISDN", partyId: req.msisdn },
        payerMessage: req.narrative.slice(0, 160),
        payeeNote: req.reference,
      }),
    });
    // 202 Accepted is the success case — the prompt is on its way, not paid.
    if (res.status !== 202) {
      const text = await res.text().catch(() => "");
      this.logger.warn(`requesttopay refused (${res.status}): ${text.slice(0, 300)}`);
      throw new ServiceUnavailableException("MTN Mobile Money refused the request");
    }
    return {
      providerRef: uuid,
      instruction: "Approve the payment request on your phone to complete this payment.",
    };
  }

  readCallback(body: unknown): CallbackReading {
    // MoMo posts the request's final state; externalId is the reference WE set.
    const reference = typeof at(body, "externalId") === "string" ? String(at(body, "externalId")) : null;
    const status = String(at(body, "status") ?? "").toUpperCase();
    const providerRef = typeof at(body, "financialTransactionId") === "string" ? String(at(body, "financialTransactionId")) : null;
    if (status === "SUCCESSFUL") return { reference, outcome: "SUCCEEDED", providerRef };
    if (status === "FAILED" || status === "REJECTED" || status === "TIMEOUT") {
      return {
        reference,
        outcome: "FAILED",
        providerRef,
        failureReason: String(at(body, "reason") ?? status) || "Payment was not completed",
      };
    }
    return { reference, outcome: "PENDING", providerRef };
  }
}

// =============================================================================
// Airtel Money — declared in coverage, adapter not written
// =============================================================================
// Present so the coverage table can be honest about where Airtel operates while
// the rail reports itself DISABLED. That is the same posture as an unimplemented
// payroll country: visible, and refusing, rather than absent and mysterious.
@Injectable()
export class AirtelProvider implements MobileMoneyProvider {
  readonly key = "AIRTEL" as const;
  isConfigured(): boolean {
    return false;
  }
  async charge(): Promise<ChargeAck> {
    throw new ServiceUnavailableException(
      "Airtel Money is not implemented yet. Choose another provider, or ask the platform operator to enable one.",
    );
  }
  readCallback(): CallbackReading {
    return { reference: null, outcome: "PENDING" };
  }
}
