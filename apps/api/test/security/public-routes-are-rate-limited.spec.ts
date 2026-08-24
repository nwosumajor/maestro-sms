// =============================================================================
// The front door, and the one place a rate limit would lose money
// =============================================================================
// `RateLimitGuard` is the in-process backstop to the edge WAF on unauthenticated
// routes. Eleven of the twenty-six public routes had it; the pattern was that
// every public POST was limited and the public GETs were not — which is the
// wrong way round for cost. Applying to a vacancy writes one row; LISTING
// vacancies queries the table, uncached, once per request, for anybody.
//
// `GET /public/schools` was the sharpest: the parent-facing directory, a
// `findMany` over every ACTIVE school, with no cache and no limit, while
// `POST /public/admissions` beside it allowed 5 a minute.
//
// THE MORE IMPORTANT HALF OF THIS FILE IS THE EXEMPTIONS. A gateway webhook must
// NEVER be rate-limited: Paystack, Stripe and the mobile-money rails retry on any
// non-2xx, a 429 is a non-2xx, and the thing being retried is a payment a parent
// has already been charged for. Someone tidying up "unprotected public routes"
// would add a limiter to those in good faith and lose money for it. The reason is
// written down here so that instinct meets an argument.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");

const ALLOWED: Record<string, string> = {
  "POST /payments/webhook":
    "NEVER limit a gateway webhook. Paystack retries on any non-2xx and a 429 is a non-2xx, so a limiter turns a burst of real payments into a retry storm and, past the retry budget, into money charged with no invoice credited. The HMAC signature is the control here.",
  "POST /billing/stripe/webhook":
    "Same for Stripe, which also retries on non-2xx. Signature-verified, and the raw body must reach the verifier unchanged.",
  "POST /payments/mobile-money/callback/:provider":
    "M-Pesa and MTN callbacks are delivered ONCE, best-effort, and are the only thing that says a payment succeeded. Refusing one with a 429 loses it outright — the recovery sweep exists because these rails do not retry.",
  "PUT /payments/mobile-money/callback/:provider":
    "The same callback over the PUT method MTN uses, and delivered once just as the POST is; a 429 loses the payment either way.",
  "POST /notifications/credits/delivery-status":
    "Twilio's delivery-status callback, signature-verified against our own public URL. A 429 here loses the confirmation a message credit was spent on.",
  "POST /public/biometric/:slug/events":
    "A gate terminal posts continuously and legitimately bursts at the start of a school day; the HMAC signature plus the freshness replay-guard are the controls. Limiting it would drop real clock-ins and the device does not retry.",
  "GET /health":
    "The liveness probe. Rate-limiting a health check makes an overloaded task look dead and get replaced, which is the opposite of what is wanted.",
  "GET /metrics":
    "The Prometheus scrape, gated by METRICS_TOKEN and polled on a fixed interval by one collector.",
  "GET /public/plan-pricing":
    "Served from a 60-second cache, so an unlimited caller costs a map lookup rather than a query.",
  "GET /public/schools/:slug/branding":
    "Served from the 60-second branding cache, and it is fetched by the login page of every school on every visit.",
  "PUT /local-storage/*":
    "The DEV storage stub, registered only when STORAGE_PROVIDER is not s3; it never exists in a deployed environment.",
  "GET /local-storage/*":
    "The same dev-only stub, serving presigned reads from the container disk; it is never registered in a deployed environment.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".controller.ts")) out.push(f);
  }
  return out;
}

interface Row { key: string; limited: boolean }

/**
 * Public routes, with each route's OWN decorator run.
 *
 * // GOTCHA: a fixed-size lookbehind picks up the PREVIOUS route's `@Public()`
 * and reports permission-gated endpoints as public — the first version of this
 * scan claimed `POST /fees/reconciliation/run` and an applicant-to-staff
 * conversion were open to the world, which would have been alarming and wrong.
 * The run is bounded by contiguous decorator/comment lines instead.
 */
function publicRoutes(): Row[] {
  const out: Row[] = [];
  for (const file of walk(API_SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    // The NEAREST @Controller above each route, not the first in the file.
    // Several files hold two controllers — `attendance.controller.ts` has the
    // staff one and the public biometric one — and taking the first reported
    // the biometric route under the wrong prefix, so its exemption did not
    // match and a genuinely-exempt route looked like an offender. This repo has
    // made that mistake before; it is in the notes as "surface gate
    // multi-controller".
    const prefixAt = (line: number): string => {
      let found = "";
      for (let j = 0; j <= line; j++) {
        const m = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(lines[j]);
        if (m) found = m[1];
      }
      return found;
    };
    for (const [i, l] of lines.entries()) {
      const m = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)\s*$/.exec(l);
      if (!m) continue;
      const run: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!(t.startsWith("@") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t === "")) break;
        run.push(lines[j]);
      }
      for (let k = i + 1; k < lines.length; k++) {
        const t = lines[k].trim();
        if (!(t.startsWith("@") || t.startsWith("//"))) break;
        run.push(lines[k]);
      }
      const block = [...run, l].join("\n");
      if (!block.includes("@Public()")) continue;
      const path = ("/" + [prefixAt(i), m[2] ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/");
      out.push({ key: `${m[1].toUpperCase()} ${path}`, limited: block.includes("RateLimitGuard") });
    }
  }
  return out;
}

describe("every unauthenticated route", () => {
  const routes = publicRoutes();

  it("was found — the scan has not silently broken", () => {
    expect(routes.length).toBeGreaterThan(15);
  });

  it("is rate-limited, or exempted by name with a reason", () => {
    const offenders = routes.filter((r) => !r.limited && !(r.key in ALLOWED)).map((r) => r.key);
    expect(offenders).toEqual([]);
  });

  it("limits the uncached public reads that had none", () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    for (const key of ["GET /public/schools", "GET /public/careers", "GET /public/careers/:slug"]) {
      expect([key, byKey.get(key)?.limited]).toEqual([key, true]);
    }
  });

  it("does NOT limit a single gateway callback", () => {
    // The property this file exists to protect. A 429 to a rail that retries is
    // a retry storm; to a rail that does not retry it is a lost payment.
    const byKey = new Map(routes.map((r) => [r.key, r]));
    for (const key of [
      "POST /payments/webhook",
      "POST /billing/stripe/webhook",
      "POST /payments/mobile-money/callback/:provider",
      "PUT /payments/mobile-money/callback/:provider",
    ]) {
      expect([key, byKey.get(key)?.limited]).toEqual([key, false]);
    }
  });

  it("gives every exemption a reason somebody could argue with", () => {
    for (const [route, why] of Object.entries(ALLOWED)) {
      expect([route, why.length > 60]).toEqual([route, true]);
    }
  });
});
