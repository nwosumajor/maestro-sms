// =============================================================================
// PUBLIC proxy (catch-all) — no session required (unlike the /api/sms BFF)
// =============================================================================
// Forwards unauthenticated reads/writes to the API's @Public `/public/*` surface
// (school directory, onboarding requests, multi-school enrolment). A more specific
// route (e.g. /api/public/admissions) takes precedence over this catch-all.
// Production fronts every public write with a rate-limiter + captcha at the edge.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { forwardedFor } from "@/lib/forwarded";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const target = `${API_BASE}/public/${ctx.params.path.join("/")}${req.nextUrl.search}`;
  // The client's address. Without it the API sees only this web task and
  // rate-limits the whole world against one bucket — see lib/forwarded.ts.
  const headers: Record<string, string> = { ...forwardedFor(req) };
  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Pass the ORIGINAL content type through (multipart uploads carry their
    // boundary in it) and forward raw bytes, not re-encoded text.
    headers["Content-Type"] = req.headers.get("content-type") ?? "application/json";
    body = Buffer.from(await req.arrayBuffer());
  }
  const res = await fetch(target, { method: req.method, headers, body });
  // Same posture as the authenticated proxy: this returns data, never a page.
  // No public route serves bytes today, which is exactly why it is worth
  // pinning now rather than after one does.
  //
  // AND DELIBERATELY NO `Cache-Control`, unlike the authenticated proxy beside
  // it, which sets `private, no-store` because everything through there is one
  // tenant's data. Everything through HERE is the school directory, plan
  // pricing and vacancy listings — identical for every caller, personal to
  // nobody — so it is the one surface a CDN could usefully cache. The API sets
  // a restrictive default at the source and this proxy does not carry it
  // across; if a public route ever starts returning something personal, that
  // decision has to be revisited here.
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export { proxy as GET, proxy as POST };
