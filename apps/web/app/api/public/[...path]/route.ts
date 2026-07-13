// =============================================================================
// PUBLIC proxy (catch-all) — no session required (unlike the /api/sms BFF)
// =============================================================================
// Forwards unauthenticated reads/writes to the API's @Public `/public/*` surface
// (school directory, onboarding requests, multi-school enrolment). A more specific
// route (e.g. /api/public/admissions) takes precedence over this catch-all.
// Production fronts every public write with a rate-limiter + captcha at the edge.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const target = `${API_BASE}/public/${ctx.params.path.join("/")}${req.nextUrl.search}`;
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Pass the ORIGINAL content type through (multipart uploads carry their
    // boundary in it) and forward raw bytes, not re-encoded text.
    headers["Content-Type"] = req.headers.get("content-type") ?? "application/json";
    body = Buffer.from(await req.arrayBuffer());
  }
  const res = await fetch(target, { method: req.method, headers, body });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
  });
}

export { proxy as GET, proxy as POST };
