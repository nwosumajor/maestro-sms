import { Injectable, Logger } from "@nestjs/common";
import type { ChannelDeliveryRequest, NotificationChannelProvider } from "./notification.constants";

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

  async deliver(req: ChannelDeliveryRequest): Promise<{ ok: boolean; error?: string }> {
    if (req.channel !== "SMS") {
      // EMAIL / PUSH / in-app: log-only here (replace with SES/FCM as needed).
      this.logger.log(`[non-sms] ${req.channel} -> ${req.target}`);
      return { ok: true };
    }
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      this.logger.warn(`[sms disabled — no Twilio creds] SMS -> ${req.target}`);
      return { ok: true }; // degrade gracefully; don't fail the pipeline
    }
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      const body = new URLSearchParams({ To: req.target, From: from, Body: `${req.title}\n${req.body}` });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`SMS -> ${req.target} failed (${res.status})`);
        return { ok: false, error: `twilio ${res.status}: ${text.slice(0, 120)}` };
      }
      this.logger.log(`[sms sent] SMS -> ${req.target}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
