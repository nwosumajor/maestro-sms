// =============================================================================
// GATEWAY WEBHOOK passthrough — the only route a payment provider can use
// =============================================================================
// The API's callback endpoints (@Public, signature-verified) had NO route from
// the internet in ANY environment:
//
//   • nginx (local) forwards only /ws/ to the API; everything else goes to web
//   • the cloud ALB has exactly one API rule, /ws/* (alb.tf, priority 1)
//   • /api/sms/* demands a session, which a webhook never has
//   • /api/public/* maps only to the API's /public/* surface, and the webhooks
//     are at /payments/webhook, /stripe/webhook and /callback/:provider
//
// So every gateway callback would have hit the Next app and 404'd. Payments
// still SETTLED, because verify-on-return and the reconciliation sweep were
// built as backstops for exactly a lost webhook — but they were carrying the
// whole load, and the events with NO backstop (disputes, subscription renewals,
// mobile-money confirmations) never arrived at all.
//
// TWO THINGS THIS MUST GET RIGHT, or it is worse than nothing:
//
//  1. THE RAW BYTES. Paystack HMACs the raw body and Stripe HMACs
//     `${timestamp}.${rawBody}`. Re-serialising JSON — even identically-shaped
//     JSON — changes the bytes and every signature fails. Buffer straight from
//     arrayBuffer(), never req.text() and re-encode.
//  2. THE SIGNATURE HEADER. Dropping it turns a verified webhook into an
//     unauthenticated one, which the API then rejects. The old /api/public
//     proxy forwarded Content-Type and nothing else.
//
// It is an ALLOWLIST, not a general opening: only these paths reach the API,
// and only these headers travel with them.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/** Public webhook path → the API route that verifies it. Nothing else passes. */
function resolveTarget(path: string[]): string | null {
  const [provider, ...rest] = path;
  if (provider === "paystack" && rest.length === 0) return "/payments/webhook";
  if (provider === "stripe" && rest.length === 0) return "/stripe/webhook";
  // Mobile money: /api/webhooks/mobile-money/mpesa → /callback/mpesa
  if (provider === "mobile-money" && rest.length === 1 && /^[a-z0-9-]+$/.test(rest[0])) {
    return `/callback/${rest[0]}`;
  }
  return null;
}

/** Only what a gateway signs with. Everything else is dropped deliberately. */
const FORWARD_HEADERS = [
  "content-type",
  "x-paystack-signature",
  "stripe-signature",
  "verif-hash", // Flutterwave-style, harmless to carry
];

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const target = resolveTarget(ctx.params.path ?? []);
  if (!target) return NextResponse.json({ error: "Unknown webhook" }, { status: 404 });

  const headers: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  // RAW BYTES. The signature is computed over exactly these.
  const body = Buffer.from(await req.arrayBuffer());

  try {
    const res = await fetch(`${API_BASE}${target}`, { method: req.method, headers, body });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    // The API is unreachable. 502 so the gateway RETRIES — the one case where a
    // non-2xx is the right answer, because the alternative is a payment that is
    // never confirmed by anything except the nightly reconciliation sweep.
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}

// MTN MoMo calls back by PUT, not POST (see the mobile-money wire notes).
export { proxy as POST, proxy as PUT };
