// =============================================================================
// EmailService — the ONE outbound-email transport (no SDK; fetch only)
// =============================================================================
// Same posture as the payment gateways: provider selected by env, HTTP-API only,
// and a clean no-op (logged, never a crash) when unconfigured. Two consumers:
//   1. EmailChannelProvider — the notification pipeline's EMAIL channel (users).
//   2. Direct sends to NON-users (e.g. the public onboarding requester, who has
//      no account yet) — same transport, so headers/from/config never fork.
//
// Env: EMAIL_PROVIDER = "resend" (default) | "postmark"
//      EMAIL_API_KEY  = provider API key (unset ⇒ email disabled, log-only)
//      EMAIL_FROM     = sender, e.g. "SMS Platform <no-reply@yourdomain>"
// SECURITY: never logs message bodies (they can carry PII) — only the target
// and subject; failures are reported to the caller, not thrown.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { envIsSet, envOr, envOrNull } from "../common/env";
import { fetchWithTimeout } from "../common/http";

const PROVIDERS = {
  resend: {
    url: "https://api.resend.com/emails",
    headers: (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    body: (from: string, to: string, subject: string, text: string) =>
      JSON.stringify({ from, to: [to], subject, text }),
  },
  postmark: {
    url: "https://api.postmarkapp.com/email",
    headers: (key: string) => ({ "X-Postmark-Server-Token": key, "Content-Type": "application/json", Accept: "application/json" }),
    body: (from: string, to: string, subject: string, text: string) =>
      JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text }),
  },
} as const;
type ProviderKey = keyof typeof PROVIDERS;

const DEFAULT_FROM = "SMS Platform <no-reply@sms.school>";

@Injectable()
export class EmailService {
  private readonly logger = new Logger("Email");

  isConfigured(): boolean {
    return !!process.env.EMAIL_API_KEY;
  }

  private provider(): ProviderKey {
    const p = envOr("EMAIL_PROVIDER", "resend").toLowerCase();
    return p in PROVIDERS ? (p as ProviderKey) : "resend";
  }

  /**
   * Send one plain-text email. Returns {ok:false} (never throws) on any failure
   * so callers — the delivery worker, best-effort direct sends — stay resilient.
   * Unconfigured ⇒ logs the attempt and reports ok (same exercisable-pipeline
   * semantics as the logging channel stub).
   */
  async send(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const key = process.env.EMAIL_API_KEY;
    if (!key) {
      this.logger.log(`[email-stub] -> ${to} (${subject})`);
      return { ok: true };
    }
    // envOr, not ??: Terraform declares `email_from` with a default of "", so a
    // deployment that does not set it hands this task an EMPTY STRING rather
    // than an absent variable — and `?? DEFAULT_FROM` never fires. Every email
    // would go out with an empty From and be rejected by the provider.
    const from = envOr("EMAIL_FROM", DEFAULT_FROM);
    const p = PROVIDERS[this.provider()];
    try {
      const res = await fetchWithTimeout(p.url, { method: "POST", headers: p.headers(key), body: p.body(from, to, subject, text) });
      if (!res.ok) {
        this.logger.warn(`email send failed (${this.provider()}): ${res.status} -> ${to} (${subject})`);
        return { ok: false, error: `provider ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      this.logger.warn(`email send error (${this.provider()}): ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Refuse to start in production when email is switched ON but has no sender.
 *
 * The fifth boot assertion, and it exists for the same reason as the other four:
 * every symptom lands somewhere this deployment cannot see. An empty From is
 * rejected by Resend and Postmark at the API, so the platform logs a warning per
 * message and nobody outside reads those — a school's parents simply stop
 * receiving receipts, invoices and password resets, and nothing says why.
 *
 * `DEFAULT_FROM` is deliberately NOT accepted here. `no-reply@sms.school` is a
 * domain this platform does not own, and mail sent from a domain you do not
 * control fails SPF and DKIM: it is not merely a placeholder, it is a placeholder
 * that gets the sending account marked as a spammer. It stays as a local
 * convenience and is refused in production.
 *
 * Only asserted when EMAIL_API_KEY is set: a deployment with no email provider at
 * all is a supported, deliberate state (the send path stubs out and says so).
 */
export function assertEmailSenderConfigured(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!envIsSet("EMAIL_API_KEY")) return;
  const from = envOrNull("EMAIL_FROM");
  if (!from) {
    throw new Error(
      "EMAIL_API_KEY is set but EMAIL_FROM is empty. Refusing to start: every outbound " +
        "email would be sent with no From address and rejected by the provider, and the only " +
        "symptom is that people stop receiving receipts, invites and password resets. " +
        "Set EMAIL_FROM to an address on a sending domain you have verified with the provider.",
    );
  }
  if (from === DEFAULT_FROM) {
    throw new Error(
      `EMAIL_FROM is still the placeholder ${DEFAULT_FROM}. Refusing to start: that domain is ` +
        "not one this platform owns, so the mail fails SPF/DKIM and gets the sending account " +
        "marked as a spammer. Set it to an address on your own verified sending domain.",
    );
  }
}
