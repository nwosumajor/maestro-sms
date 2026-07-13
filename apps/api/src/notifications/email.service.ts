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
    const p = (process.env.EMAIL_PROVIDER ?? "resend").toLowerCase();
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
    const from = process.env.EMAIL_FROM ?? DEFAULT_FROM;
    const p = PROVIDERS[this.provider()];
    try {
      const res = await fetch(p.url, { method: "POST", headers: p.headers(key), body: p.body(from, to, subject, text) });
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
