// =============================================================================
// PUBLIC admissions proxy — no session required (unlike the /api/sms BFF)
// =============================================================================
// Forwards an unauthenticated admissions application to the API's @Public
// endpoint. This is the ONLY public write path; production fronts it with a
// rate-limiter + captcha at the edge.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await fetch(`${API_BASE}/public/admissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
