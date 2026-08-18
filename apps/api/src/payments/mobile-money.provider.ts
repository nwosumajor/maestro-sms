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
import { fetchWithTimeout } from "../common/http";

/** What a rail is asked to do. Provider-agnostic by construction. */
export interface ChargeRequest {
  /** OUR reference — the idempotency key we will match a callback on. */
  reference: string;
  amountMinor: number;
  currency: string;
  /** Normalised MSISDN (country code, no plus, no trunk zero). */
  msisdn: string;
  /** ISO 3166-1 alpha-2 of the school. Airtel requires it as a header AND in the
   *  body; the others do not need it. Carried for all rails so no adapter has to
   *  reverse-engineer a country from a dialling prefix. */
  country: string;
  /** The dialling code `msisdn` was normalised with. Airtel wants the NATIONAL
   *  number, so it is the only way to take the prefix back off correctly — Kenya's
   *  254 and Uganda's 256 are both three digits, but guessing a length is how a
   *  Cameroonian (237) number silently loses a digit. */
  dialCode: string;
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
  /**
   * True when the rail can only be asked for WHOLE currency units.
   *
   * Daraja rejects a decimal Amount outright. The naive handling — round in the
   * adapter — charges the payer 501 for a 500.50 balance while the ledger credits
   * 500.50, so the payer is 0.50 out of pocket with nothing recording it. The
   * service instead floors the ASK to whole units before writing the intent, so
   * what we request, what the payer approves and what we credit are one number.
   */
  readonly wholeUnitsOnly: boolean;
  /** False when the platform holds no credentials for this rail. A provider is
   *  DISABLED, never half-working. */
  isConfigured(): boolean;
  charge(req: ChargeRequest): Promise<ChargeAck>;
  readCallback(body: unknown): CallbackReading;
  /**
   * Ask the rail what became of a charge.
   *
   * THE REASON THIS EXISTS: a mobile-money callback is the only thing that tells
   * us a payment succeeded, it is unsigned, and it is delivered exactly once on a
   * best-effort basis. Lose it to a deploy, a 5xx or a network blip and the payer
   * has been debited while the invoice stays open forever — the same failure the
   * card rails have a reconciliation sweep to prevent. Polling is that sweep's
   * missing half.
   *
   * Takes the intent's own identifiers so each rail can use whichever it is keyed
   * on: M-Pesa queries by CheckoutRequestID, MTN by the X-Reference-Id it was
   * given, Airtel by our transaction id.
   */
  getStatus(ref: { reference: string; providerRef: string | null }): Promise<CallbackReading>;
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
  readonly wholeUnitsOnly = true;
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
    const res = await fetchWithTimeout(`${this.base()}/oauth/v1/generate?grant_type=client_credentials`, {
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

    // Daraja rejects decimals. The service has already floored the ask to whole
    // units (wholeUnitsOnly), so this is a whole number by construction — asserted
    // rather than rounded, because rounding HERE is what silently overcharges.
    const amount = toMajor(req.amountMinor, req.currency);
    if (!Number.isInteger(amount)) {
      throw new ServiceUnavailableException("M-Pesa accepts whole shillings only");
    }

    const res = await fetchWithTimeout(`${this.base()}/mpesa/stkpush/v1/processrequest`, {
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

  async getStatus(ref: { reference: string; providerRef: string | null }): Promise<CallbackReading> {
    // Daraja's STK query is keyed ONLY on CheckoutRequestID. Without one there is
    // nothing to ask about, and guessing would be worse than waiting.
    if (!this.isConfigured() || !ref.providerRef) return { reference: ref.reference, outcome: "PENDING" };
    const shortcode = process.env.MPESA_SHORTCODE!;
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${ts}`).toString("base64");
    try {
      const res = await fetchWithTimeout(`${this.base()}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: ts,
          CheckoutRequestID: ref.providerRef,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // ResultCode 0 = paid. 1032 = cancelled, 1037 = timed out, etc. Anything we
      // cannot read stays PENDING: "we do not know" must never settle or fail a
      // charge, because both are one-way.
      const code = body.ResultCode;
      if (code === undefined || code === null) return { reference: ref.reference, outcome: "PENDING", providerRef: ref.providerRef };
      // 500.001.1001 means the transaction is still being processed.
      if (String(code) === "500.001.1001") return { reference: ref.reference, outcome: "PENDING", providerRef: ref.providerRef };
      const ok = Number(code) === 0;
      return {
        reference: ref.reference,
        outcome: ok ? "SUCCEEDED" : "FAILED",
        providerRef: ref.providerRef,
        failureReason: ok ? null : String(body.ResultDesc ?? "Payment was not completed"),
      };
    } catch (err) {
      this.logger.warn(`STK query failed for ${ref.providerRef}: ${(err as Error).message}`);
      return { reference: ref.reference, outcome: "PENDING", providerRef: ref.providerRef };
    }
  }

  readCallback(body: unknown): CallbackReading {
    const cb = at(body, "Body", "stkCallback");
    const code = at(cb, "ResultCode");

    // MATCHED ON CheckoutRequestID, NOT on our AccountReference.
    //
    // Daraja does NOT echo AccountReference back. Its CallbackMetadata carries
    // Amount, MpesaReceiptNumber, TransactionDate and PhoneNumber — nothing else.
    // An earlier version of this adapter looked for AccountReference, found
    // nothing, and would have dropped EVERY real callback: the payer debited, the
    // invoice never credited. CheckoutRequestID is what Daraja returns on the STK
    // push AND on the callback, so it is the join.
    const providerRef = typeof at(cb, "CheckoutRequestID") === "string" ? String(at(cb, "CheckoutRequestID")) : null;

    // Some aggregators fronting Daraja DO echo the account reference; take it when
    // present, as a second way to find the intent. Never as the only way.
    const items = at(cb, "CallbackMetadata", "Item");
    let reference: string | null = null;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (at(it, "Name") === "AccountReference") reference = String(at(it, "Value") ?? "") || null;
      }
    }
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

/**
 * MTN's `X-Reference-Id` — the transaction's identity and its idempotency key.
 *
 * DERIVED from our reference rather than freshly random, so that retrying the
 * same charge is idempotent at MTN's end too: a second requesttopay with a
 * reference-id MTN has already seen is rejected as a duplicate instead of
 * prompting the payer twice for one invoice.
 *
 * It must also be a WELL-FORMED UUIDv4. MTN types the field as a uuid, and the
 * earlier derivation left whatever nibbles fell out of our reference in the
 * version and variant positions — `…-5D06-CA00-…`, which is not a v4 and which a
 * strict validator refuses. Pinning nibble 13 to `4` and nibble 17 into `[89ab]`
 * costs nothing and is still fully determined by the reference.
 */
export function mtnReferenceId(reference: string): string {
  const hex = reference.replace(/[^a-f0-9]/gi, "").toLowerCase().padEnd(32, "0").slice(0, 32);
  const v4 = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${"89ab"[parseInt(hex[16], 16) % 4]}${hex.slice(17, 32)}`;
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${v4.slice(16, 20)}-${v4.slice(20, 32)}`;
}

@Injectable()
export class MtnMomoProvider implements MobileMoneyProvider {
  readonly key = "MTN_MOMO" as const;
  readonly wholeUnitsOnly = false;
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
    const res = await fetchWithTimeout(`${this.base()}/collection/token/`, {
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
    const uuid = mtnReferenceId(req.reference);
    // MoMo takes the MAJOR unit as a string. `toMajor` asks the currency, so a
    // zero-decimal currency (XAF, XOF, RWF, UGX) is not divided by 100.
    const amount = toMajor(req.amountMinor, req.currency).toString();
    // THE SANDBOX ONLY SETTLES EUR. Sending the school's real currency there is
    // rejected, which reads as "our integration is broken" when it is the sandbox
    // being the sandbox. Production sends the actual currency.
    const currency = this.target() === "sandbox" ? "EUR" : req.currency;

    const res = await fetchWithTimeout(`${this.base()}/collection/v1_0/requesttopay`, {
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
        currency,
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

  async getStatus(ref: { reference: string; providerRef: string | null }): Promise<CallbackReading> {
    if (!this.isConfigured()) return { reference: ref.reference, outcome: "PENDING" };
    // Keyed on the X-Reference-Id we generated at charge time — which is exactly
    // why that id had to be DERIVED from our reference and a well-formed UUID.
    const id = ref.providerRef ?? mtnReferenceId(ref.reference);
    try {
      const res = await fetchWithTimeout(`${this.base()}/collection/v1_0/requesttopay/${encodeURIComponent(id)}`, {
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          "X-Target-Environment": this.target(),
          "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY!,
        },
      });
      if (!res.ok) return { reference: ref.reference, outcome: "PENDING", providerRef: id };
      // Same body shape as the callback, so one reader serves both.
      return { ...this.readCallback(await res.json()), providerRef: id };
    } catch (err) {
      this.logger.warn(`MoMo status failed for ${id}: ${(err as Error).message}`);
      return { reference: ref.reference, outcome: "PENDING", providerRef: id };
    }
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
// Airtel Money — Collections (Airtel Africa Open API)
// =============================================================================
// Written from Airtel's published API. It differs from the other two rails in
// three ways that each break a charge silently if assumed away:
//
//   1. AUTH IS A JSON POST, not HTTP Basic. Credentials go in the body.
//   2. THE MSISDN IS NATIONAL, not international. Airtel takes the country
//      separately (header AND body) and wants the subscriber number WITHOUT its
//      dialling code — the exact opposite of M-Pesa and MTN.
//   3. THE CALLBACK URL IS CONFIGURED IN AIRTEL'S PORTAL, not sent per charge.
//      Nothing we pass here changes where the notification lands.
//
// Like the others: no credentials ⇒ DISABLED, never half-working.
// =============================================================================

/** Airtel wants the national significant number — the dial code taken back off. */
export function airtelNationalMsisdn(msisdn: string, dialCode: string): string {
  return msisdn.startsWith(dialCode) ? msisdn.slice(dialCode.length) : msisdn;
}

@Injectable()
export class AirtelProvider implements MobileMoneyProvider {
  readonly key = "AIRTEL" as const;
  // Airtel's published examples are whole-unit amounts, and its markets (UGX, TZS,
  // KES) are transacted in whole units in practice. Conservative by choice: a
  // whole-unit ask can only UNDER-charge, leaving the fraction visible on the
  // invoice, where over-asking would take money the ledger never credits.
  readonly wholeUnitsOnly = true;
  private readonly logger = new Logger("Airtel Money");

  isConfigured(): boolean {
    return !!(process.env.AIRTEL_CLIENT_ID && process.env.AIRTEL_CLIENT_SECRET);
  }

  private base(): string {
    // UAT by default, for the same reason the other two default to sandbox: a
    // deployment that is misconfigured must not move real money.
    return process.env.AIRTEL_ENV === "production"
      ? "https://openapi.airtel.africa"
      : "https://openapiuat.airtel.africa";
  }

  private async token(): Promise<string> {
    // NOT Basic auth — Airtel takes the credentials as a JSON body.
    const res = await fetchWithTimeout(`${this.base()}/auth/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({
        client_id: process.env.AIRTEL_CLIENT_ID,
        client_secret: process.env.AIRTEL_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) throw new ServiceUnavailableException("Airtel Money authentication failed");
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new ServiceUnavailableException("Airtel Money returned no access token");
    return body.access_token;
  }

  async charge(req: ChargeRequest): Promise<ChargeAck> {
    if (!this.isConfigured()) throw new ServiceUnavailableException("Airtel Money is not configured");

    // Whole units by construction (wholeUnitsOnly), so this asserts rather than
    // rounds — rounding here is what overcharged a payer on the M-Pesa rail.
    const amount = toMajor(req.amountMinor, req.currency);
    if (!Number.isInteger(amount)) {
      throw new ServiceUnavailableException("Airtel Money accepts whole units only");
    }
    const country = req.country.toUpperCase();
    const msisdn = airtelNationalMsisdn(req.msisdn, req.dialCode);

    const res = await fetchWithTimeout(`${this.base()}/merchant/v1/payments/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        // Mandatory. Airtel routes on these, not on the number's prefix.
        "X-Country": country,
        "X-Currency": req.currency,
      },
      body: JSON.stringify({
        reference: req.narrative.slice(0, 100),
        subscriber: { country, currency: req.currency, msisdn },
        // transaction.id is OUR reference, and Airtel echoes it on the callback —
        // so unlike M-Pesa, this rail CAN be matched on our own id.
        transaction: { amount, country, currency: req.currency, id: req.reference },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Airtel answers 200 with success:false. The HTTP status alone is not the
    // outcome — trusting it reports a prompt as sent that never left Airtel.
    if (!res.ok || at(body, "status", "success") !== true) {
      const message = at(body, "status", "message");
      this.logger.warn(`Airtel collection refused: ${JSON.stringify(body).slice(0, 300)}`);
      throw new ServiceUnavailableException(
        typeof message === "string" && message ? message : "Airtel Money refused the request",
      );
    }
    const id = at(body, "data", "transaction", "id");
    return {
      providerRef: typeof id === "string" ? id : null,
      instruction: "Approve the payment request on your phone to complete this payment.",
    };
  }

  async getStatus(ref: { reference: string; providerRef: string | null }): Promise<CallbackReading> {
    if (!this.isConfigured()) return { reference: ref.reference, outcome: "PENDING" };
    // Airtel's enquiry is keyed on the transaction id WE sent, not on its own —
    // the opposite of M-Pesa, and the reason this takes both identifiers.
    try {
      const res = await fetchWithTimeout(`${this.base()}/standard/v1/payments/${encodeURIComponent(ref.reference)}`, {
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: "*/*",
          "X-Country": (process.env.AIRTEL_COUNTRY ?? "").toUpperCase(),
          "X-Currency": (process.env.AIRTEL_CURRENCY ?? "").toUpperCase(),
        },
      });
      if (!res.ok) return { reference: ref.reference, outcome: "PENDING", providerRef: ref.providerRef };
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // The enquiry nests the transaction one level deeper than the callback does.
      const tx = at(body, "data", "transaction");
      return this.readCallback({ transaction: { ...(tx as object), id: ref.reference } });
    } catch (err) {
      this.logger.warn(`Airtel status failed for ${ref.reference}: ${(err as Error).message}`);
      return { reference: ref.reference, outcome: "PENDING", providerRef: ref.providerRef };
    }
  }

  readCallback(body: unknown): CallbackReading {
    // Airtel's callback nests the transaction and reports a two-letter code:
    // TS = success, TF = failed, TA = ambiguous (treated as still pending, because
    // "we do not know" must never post money).
    const tx = at(body, "transaction");
    const reference = typeof at(tx, "id") === "string" ? String(at(tx, "id")) : null;
    const providerRef =
      typeof at(tx, "airtel_money_id") === "string" ? String(at(tx, "airtel_money_id")) : null;
    const code = String(at(tx, "status_code") ?? "").toUpperCase();
    if (code === "TS") return { reference, outcome: "SUCCEEDED", providerRef };
    if (code === "TF") {
      return {
        reference,
        outcome: "FAILED",
        providerRef,
        failureReason: String(at(tx, "message") ?? "") || "Payment was not completed",
      };
    }
    return { reference, outcome: "PENDING", providerRef };
  }
}
