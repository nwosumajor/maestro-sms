// =============================================================================
// Webhook passthrough targets must match the controllers they point at
// =============================================================================
// The web tier exposes ONE sessionless route a payment provider can reach,
// /api/webhooks/<provider>, and forwards it to the API handler that verifies
// the signature. That mapping is written by hand, and when it was written TWO
// of the three entries were wrong:
//
//   stripe        -> /stripe/webhook                 (really /billing/stripe/webhook)
//   mobile-money  -> /callback/:provider             (really /payments/mobile-money/callback/:provider)
//
// Nothing caught it because Paystack — the only entry that was right — is the
// only rail switched on, so it is the only one anyone had exercised.
//
// A wrong target is a 404 to a provider. For a card rail that is recoverable
// (the reconciliation sweep finds the charge later). For MOBILE MONEY it is
// not: those callbacks are delivered once, best-effort, with no retry, so the
// payer is debited and the invoice stays open until the hourly recovery sweep
// happens to notice — if it is running at all.
//
// So this pins each target against the controller's ACTUAL route, assembled
// from its @Controller prefix and the @Post path, rather than against a copy of
// the string in the test.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { controllerPrefixAt, joinRoute } from "../support/api-routes";

const WEB_ROUTE = join(__dirname, "../../../web/app/api/webhooks/[...path]/route.ts");

/** The route a controller actually serves: @Controller prefix + @Post path. */
function actualRoute(controllerFile: string, postPath: string): string {
  const src = readFileSync(join(__dirname, "../../src", controllerFile), "utf8");
  if (!/@Controller\(/.test(src)) throw new Error(`no @Controller in ${controllerFile}`);
  // Prove the handler is really declared at the path we are assembling from.
  expect(src).toContain(`@Post("${postPath}")`);
  // Resolved against the controller this handler sits under, not the first one
  // in the file — a file may declare two.
  const base = controllerPrefixAt(src, src.indexOf(`@Post("${postPath}")`));
  return joinRoute(base, postPath);
}

describe("webhook passthrough targets", () => {
  const passthrough = readFileSync(WEB_ROUTE, "utf8");

  it("routes Paystack to the controller that verifies its signature", () => {
    const route = actualRoute("fees/fees.controller.ts", "payments/webhook");
    expect(route).toBe("/payments/webhook");
    expect(passthrough).toContain(`return "${route}"`);
  });

  it("routes Stripe to the BILLING controller, where its handler actually lives", () => {
    // Was "/stripe/webhook" — a 404, so every Stripe event would have been lost.
    const route = actualRoute("billing/billing.controller.ts", "stripe/webhook");
    expect(route).toBe("/billing/stripe/webhook");
    expect(passthrough).toContain(`return "${route}"`);
  });

  it("routes mobile money under the payments/mobile-money prefix", () => {
    // Was "/callback/:provider". Mobile-money callbacks are delivered ONCE with
    // no retry, so a 404 here debits the payer and settles nothing.
    const route = actualRoute("payments/mobile-money.controller.ts", "callback/:provider");
    expect(route).toBe("/payments/mobile-money/callback/:provider");
    expect(passthrough).toContain("/payments/mobile-money/callback/${rest[0]}");
  });

  it("routes Twilio delivery status to the handler that refunds the credit", () => {
    // Added late and initially MISSED: the API route was marked @Public but
    // never given a passthrough, so Twilio got a 404 and the refund path could
    // never have fired in production. The route is @Public on a controller with
    // no prefix collision, so its full path is what the passthrough must name.
    const route = actualRoute("notifications/notification.controller.ts", "credits/delivery-status");
    expect(route).toBe("/notifications/credits/delivery-status");
    expect(passthrough).toContain(`return "${route}"`);
  });

  it("carries the header Twilio signs with", () => {
    expect(passthrough).toContain("x-twilio-signature");
  });

  it("still refuses anything not on the allowlist", () => {
    // The allowlist is the security property: this route is sessionless, so it
    // must reach signature-verifying handlers and nothing else.
    expect(passthrough).toContain("return null");
    expect(passthrough).toMatch(/\/\^\[a-z0-9-\]\+\$\//); // provider slug is constrained
  });

  it("forwards the RAW bytes, never re-serialised JSON", () => {
    // Paystack HMACs the raw body and Stripe HMACs `${t}.${rawBody}` — a
    // byte-identical re-encode still breaks the signature.
    expect(passthrough).toContain("arrayBuffer");
    expect(passthrough).not.toContain("JSON.stringify");
  });

  it("carries the signature headers each rail signs with", () => {
    for (const header of ["x-paystack-signature", "stripe-signature", "verif-hash"]) {
      expect(passthrough).toContain(header);
    }
  });
});

describe("every gateway RETURN url has a page that acts on it", () => {
  // The defect this catches, twice over: a checkout sends the gateway a
  // callback_url, the API grows the endpoint to settle it — and nothing on the
  // page ever calls that endpoint. The redirect then lands on a screen that
  // does nothing, and the money only appears when a daily sweep next runs.
  //
  // It happened to credit bundles exactly this way: callback_url shipped,
  // POST /notifications/credits/verify shipped, no caller. A school charged
  // NGN 50,000 saw an unchanged balance and reasonably assumed it had failed.
  const WEB = join(__dirname, "../../../web");

  function apiSources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) apiSources(full, out);
      else if (e.endsWith(".ts") && !e.endsWith(".spec.ts")) out.push(full);
    }
    return out;
  }

  function webSources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) webSources(full, out);
      else if (e.endsWith(".tsx") || e.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("names a query parameter the billing/fees pages actually read", () => {
    // Collect every `?<param>=` a callback_url is built with in the API...
    const params = new Set<string>();
    for (const f of apiSources(join(__dirname, "../../src"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/callbackUrl:[\s\S]{0,200}?\?([a-zA-Z]+)=/g)) params.add(m[1]);
    }
    expect(params.size).toBeGreaterThan(0);

    // ...and require the web tier to mention each one somewhere.
    const web = webSources(WEB).map((f) => readFileSync(f, "utf8")).join("\n");
    const unhandled = [...params].filter((p) => !web.includes(p));
    expect(unhandled).toEqual([]);
  });
});
