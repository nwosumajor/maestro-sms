import crypto from "node:crypto";
import { envOrNull } from "../common/env";
import { Injectable, Logger } from "@nestjs/common";
import type { ChannelDeliveryRequest, ChannelDeliveryResult, NotificationChannelProvider } from "./notification.constants";
import { fetchWithTimeout, GATEWAY_TIMEOUT_MS } from "../common/http";
import { smsCost, toSmsSafe } from "@sms/types";

/**
 * Production channel provider with a LIVE SMS gateway (Twilio) for SMS deliveries.
 * Non-SMS channels (EMAIL / PUSH / in-app) fall back to log-only here — wire SES /
 * FCM the same way when needed. Bound only when STORAGE-style creds are present:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (sender number).
 * When creds are absent the SMS path degrades to log-only (no throw), so the
 * delivery pipeline stays exercisable in dev/sandbox without outbound network.
 * Never logs the message body (PII) — only channel + target.
 */
@Injectable()
export class TwilioChannelProvider implements NotificationChannelProvider {
  private readonly logger = new Logger("NotificationChannel");

  async deliver(req: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (req.channel !== "SMS" && req.channel !== "WHATSAPP") {
      // EMAIL / PUSH / in-app: log-only here (replace with SES/FCM as needed).
      this.logger.log(`[non-sms] ${req.channel} -> ${req.target}`);
      return { ok: true };
    }
    const sid = envOrNull("TWILIO_ACCOUNT_SID");
    const token = envOrNull("TWILIO_AUTH_TOKEN");
    // WhatsApp uses its own approved sender, falling back to the SMS number.
    //
    // envOrNull, not `??`: Terraform declares `twilio_whatsapp_from` with a
    // default of "", so a deployment that does not set it hands this task an
    // EMPTY STRING, and `?? process.env.TWILIO_FROM` never fires — the fallback
    // this very comment describes was unreachable for the commonest possible
    // configuration.
    const from =
      req.channel === "WHATSAPP"
        ? envOrNull("TWILIO_WHATSAPP_FROM") ?? envOrNull("TWILIO_FROM")
        : envOrNull("TWILIO_FROM");

    // NOT CONFIGURED AT ALL is a different thing from MIS-configured, and they
    // must not share an answer.
    //
    // Both used to return { ok: true } — "degrade gracefully; don't fail the
    // pipeline" — which is right for a deployment with no Twilio account: the
    // stub semantics the logging provider has. It is wrong when the credentials
    // ARE present and only the sender is missing, because `ok` is what
    // `NotificationService` reads to decide whether to DEBIT A PAID MESSAGE
    // CREDIT. A school would be charged for every WhatsApp message, none of
    // which were sent, each one recorded SENT. The old log line even said "no
    // Twilio creds" when the creds were fine.
    if (!sid || !token) {
      this.logger.warn(`[messaging disabled — no Twilio creds] ${req.channel} -> ${req.target}`);
      return { ok: true }; // degrade gracefully; don't fail the pipeline
    }
    if (!from) {
      const missing = req.channel === "WHATSAPP" ? "TWILIO_WHATSAPP_FROM or TWILIO_FROM" : "TWILIO_FROM";
      this.logger.error(
        `${req.channel} not sent: Twilio is configured but no sender is set (${missing}). ` +
          `No message credit has been spent.`,
      );
      return { ok: false, error: `no ${req.channel} sender configured` };
    }
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      // Twilio's WhatsApp transport is the same Messages API with a prefix.
      const prefix = req.channel === "WHATSAPP" ? "whatsapp:" : "";
      // An SMS is billed by the SEGMENT and the school is debited ONE credit
      // per message, so a single character outside GSM-7 doubles what the
      // platform pays for a message it charges once for. `toSmsSafe` removes
      // the characters that cost without saying anything — the invisible
      // no-break space `Intl` puts in "Ksh 25,000.00", and the currency symbol,
      // swapped for its own ISO code exactly as `formatMoneyPdf` already does
      // for a PDF. It never touches a NAME: a pupil called `Ṣadé` is sent as
      // `Ṣadé` at whatever that costs.
      //
      // SMS ONLY. WhatsApp rides the same Messages API and is a DIFFERENT
      // product: billed per CONVERSATION rather than per segment, and it
      // renders Unicode natively. Folding `₦` to `NGN ` there degrades the
      // message a family reads and saves nothing — GSM-7 is a constraint of the
      // SMS wire, not of Twilio.
      const isSms = req.channel !== "WHATSAPP";
      const raw = `${req.title}\n${req.body}`;
      const text = isSms ? toSmsSafe(raw) : raw;
      const cost = isSms ? smsCost(text) : null;
      const body = new URLSearchParams({
        To: `${prefix}${req.target}`,
        From: `${prefix}${from}`,
        Body: text,
      });
      // A BOUNDED wait. Node's fetch has no default timeout, so a stalled
      // connection here hung the delivery worker indefinitely — and until this
      // call was moved out of the delivery transaction, it hung that too, until
      // Prisma's five-second cap rolled back a message Twilio had already sent.
      // Timing out is also the honest answer: an unanswered request must be
      // treated as "unknown, do not spend a credit", which is what the FAILED
      // path below does.
      const res = await fetchWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`${req.channel} -> ${req.target} failed (${res.status})`);
        return { ok: false, error: `twilio ${res.status}: ${text.slice(0, 120)}` };
      }
      // KEEP THE SID. Twilio returns it on every accepted message and this
      // adapter used to drop it, which is why no reconciliation between our
      // debits and the provider's billed messages was possible.
      //
      // NOTE what `ok` means here: Twilio has ACCEPTED and queued the message,
      // not delivered it. A carrier reject afterwards still spent the school's
      // credit — closing that needs Twilio's status callback, which the SID is
      // also the key for.
      const json = (await res.json().catch(() => null)) as
        | { sid?: string; num_segments?: string }
        | null;
      // KEEP THE SEGMENT COUNT TOO. One credit is debited per MESSAGE and the
      // provider bills per SEGMENT, so this is the difference between what the
      // school paid and what the send cost — invisible until it is recorded.
      // Twilio's own count is authoritative; ours is the fallback when the
      // response does not carry one.
      // Segments are an SMS notion. Reporting one for WhatsApp would put a
      // number into the exposure figure that the provider never billed —
      // undefined is not 1, the same rule the field's own doc states.
      const segments = cost ? Number(json?.num_segments) || cost.segments : undefined;
      this.logger.log(
        `[sent] ${req.channel} -> ${req.target}${json?.sid ? ` (${json.sid})` : ""}` +
          (cost && segments !== undefined
            ? ` ${cost.encoding} ${segments} segment${segments === 1 ? "" : "s"}`
            : ""),
      );
      return { ok: true, providerRef: json?.sid, segments };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * What Twilio says it accepted since `since` — the other half of the
   * reconciliation. Mirrors the card rails' listSuccessfulTransactions.
   *
   * Paged, because a busy platform sends more than one page a day and a
   * silently truncated listing would report every un-listed message as
   * "uncharged" — an alarm about a problem that does not exist.
   */
  async listRecentMessages(
    since: Date,
  ): Promise<Array<{ providerRef: string; status?: string; segments?: number }>> {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return [];
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const out: Array<{ providerRef: string; status?: string; segments?: number }> = [];
    let url: string | null =
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json` +
      `?DateSent%3E=${since.toISOString().slice(0, 10)}&PageSize=1000`;

    for (let page = 0; url && page < 20; page++) {
      const res: Response = await fetchWithTimeout(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Twilio message listing failed: ${res.status}`);
        // Partial data would understate what the provider sent, which reads as
        // "the platform was charged for messages it never sent". Refuse instead.
        throw new Error(`twilio listing ${res.status}`);
      }
      const json = (await res.json()) as {
        messages?: Array<{ sid?: string; status?: string; num_segments?: string }>;
        next_page_uri?: string | null;
      };
      // Carry the SEGMENT COUNT, for the same reason the SID is carried: the
      // question "what did the platform actually pay for what it charged once?"
      // cannot be asked from a listing that drops the answer.
      for (const m of json.messages ?? [])
        if (m.sid)
          out.push({
            providerRef: m.sid,
            status: m.status,
            segments: Number(m.num_segments) || undefined,
          });
      url = json.next_page_uri ? `https://api.twilio.com${json.next_page_uri}` : null;
    }
    return out;
  }

  /**
   * Twilio signs a callback with HMAC-SHA1 over the full URL plus every POST
   * parameter appended in sorted key order, base64-encoded.
   *
   * Every other webhook on this platform is verified, and this one arrives at a
   * PUBLIC route that hands credits back — unverified, anyone who learned a
   * message SID could refund a school's credits at will. The refund is bounded
   * (one per SID, only for a credit actually spent), so the loss is capped, but
   * an unauthenticated write to a money ledger should not be reachable at all.
   *
   * Returns false when no auth token is configured: an unverifiable callback is
   * refused, not trusted.
   */
  verifyCallbackSignature(url: string, params: Record<string, string>, signature: string | null): boolean {
    return verifyTwilioSignature(url, params, signature);
  }
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token || !signature) return false;
    const payload = Object.keys(params)
      .sort()
      .reduce((acc, k) => acc + k + params[k], url);
    const expected = crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf8")).digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // Length-guard first: timingSafeEqual THROWS on a length mismatch, so an
    // unguarded short signature is a 500 rather than a rejection.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
