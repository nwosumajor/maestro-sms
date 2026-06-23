// =============================================================================
// BFF proxy: browser → NestJS API, with auth injected server-side
// =============================================================================
// The browser posts integrity signals / autosave / submit to THIS same-origin
// route; we attach a freshly-minted Bearer (from the session) and forward to the
// API. This keeps AUTH_SECRET on the server and means the browser never holds a
// verifiable API token. The API still enforces permission + tenant + RLS.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const token = await bearerForSession();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });

  const target = `${API_BASE}/${ctx.params.path.join("/")}${req.nextUrl.search}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  // Forward a step-up re-auth token for sensitive routes (the API verifies it).
  const stepup = req.headers.get("x-stepup");
  if (stepup) headers["x-stepup"] = stepup;
  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    body = await req.text();
  }

  const res = await fetch(target, { method: req.method, headers, body });
  const ct = res.headers.get("content-type") ?? "application/json";
  // Text/JSON pass through as text; binary (e.g. report-card PDFs) as bytes.
  if (ct.includes("json") || ct.includes("text") || ct.includes("html")) {
    return new NextResponse(await res.text(), { status: res.status, headers: { "Content-Type": ct } });
  }
  const out: Record<string, string> = { "Content-Type": ct };
  const cd = res.headers.get("content-disposition");
  if (cd) out["Content-Disposition"] = cd;
  return new NextResponse(await res.arrayBuffer(), { status: res.status, headers: out });
}

// Forward every method the API exposes (SIS uses PUT/PATCH/DELETE); the proxy
// body handling already covers all non-GET verbs generically.
export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
