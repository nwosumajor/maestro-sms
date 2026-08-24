// =============================================================================
// Where this deployment lives, decided ONCE
// =============================================================================
// `process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"` appeared TWELVE times:
// Paystack and Stripe return URLs, the billing and credits checkout callbacks,
// invite links, password-reset links, the admissions documents link, and the URL
// the TWILIO SIGNATURE is verified against.
//
// Every one of them fails the same way if the variable is missing, and none of
// them says so. In production that would be: payers returned to localhost so
// verify-on-return never fires, invite and reset links emailed to real people
// pointing at their own machine, and a Twilio signature computed over the wrong
// URL — which never matches, so credit refunds stop silently.
//
// Two services already refused to take part in that: mobile-money and admissions
// return EMPTY and warn rather than send half a URL, each with a comment
// explaining why. They were right, and the other twelve were guessing.
//
// // GOTCHA: the fallbacks were not even consistent with the stack around them —
// the code guessed `http://localhost:3000` (the Next dev server) while
// docker-compose sets `http://localhost` (nginx). A default nobody can rely on
// is a default that should not exist, so in PRODUCTION an unset value now
// refuses to boot, alongside the storage, encryption and signing-key checks.
// =============================================================================

import { envOr } from "./env";

/** The public origin of this deployment, without a trailing slash. */
export function publicWebUrl(): string {
  const raw = envOr("PUBLIC_WEB_URL", "http://localhost:3000");
  return raw.replace(/\/+$/, "");
}

/**
 * Refuse to start in production without a public URL.
 *
 * Production only, like its siblings: local work runs on the default. What makes
 * this worth a boot failure rather than a warning is that every symptom is
 * remote and silent — a payer's browser, somebody else's inbox, a webhook that
 * quietly stops matching — so nothing on this side reports it.
 */
export function assertPublicWebUrlConfigured(): void {
  if (!process.env.PUBLIC_WEB_URL?.trim() && process.env.NODE_ENV === "production") {
    throw new Error(
      "PUBLIC_WEB_URL is not set. Refusing to start: payment returns, invite links, " +
        "password-reset links and the Twilio signature check would all be built against " +
        "localhost, and every symptom of that appears somewhere this deployment cannot see.",
    );
  }
}
