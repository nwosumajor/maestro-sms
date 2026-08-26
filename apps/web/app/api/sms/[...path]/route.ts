// =============================================================================
// BFF proxy: browser → NestJS API, with auth injected server-side
// =============================================================================
// The browser posts integrity signals / autosave / submit to THIS same-origin
// route; we attach a freshly-minted Bearer (from the session) and forward to the
// API. This keeps AUTH_SECRET on the server and means the browser never holds a
// verifiable API token. The API still enforces permission + tenant + RLS.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { forwardedFor } from "@/lib/forwarded";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const token = await bearerForSession();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });

  const target = `${API_BASE}/${ctx.params.path.join("/")}${req.nextUrl.search}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // The client's address — the API's per-tenant and per-IP limits are both
    // meaningless when every request appears to come from this web task.
    ...forwardedFor(req),
  };
  // Forward a step-up re-auth token for sensitive routes (the API verifies it).
  const stepup = req.headers.get("x-stepup");
  if (stepup) headers["x-stepup"] = stepup;
  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Pass the ORIGINAL content type through and forward RAW BYTES, matching the
    // public proxy beside this one.
    //
    // This used to hard-code `application/json` and re-encode the body as text.
    // Nothing authenticated sends multipart today — document uploads go straight
    // to storage on a presigned URL — so it was not a live fault. It was a trap:
    // the first authenticated file upload would arrive at the API as JSON-
    // labelled text with the multipart boundary lost, and would fail in a way
    // that looks like a broken endpoint rather than a broken proxy. The public
    // proxy already hit exactly that and was fixed; this one was left behind.
    headers["Content-Type"] = req.headers.get("content-type") ?? "application/json";
    body = Buffer.from(await req.arrayBuffer());
  }

  const res = await fetch(target, { method: req.method, headers, body });
  const ct = res.headers.get("content-type") ?? "application/json";

  // CONTENT-DISPOSITION IS FORWARDED WHATEVER THE TYPE.
  //
  // It used to be attached only on the binary branch, and that one omission was
  // a stored-XSS hole: the document endpoint replays the content type given at
  // upload, so a file declared `text/html` came back down the TEXT branch and
  // arrived at the browser as text/html with the API's `attachment` stripped
  // off — rendered, not downloaded, on this origin, with the reader's session.
  // Demonstrated end to end before this fix: the API answered `text/html` +
  // `Content-Disposition: attachment`, and the browser received `text/html`
  // and no disposition at all. There is no CSP to fall back on.
  //
  // It also silently broke every CSV export — text/csv took the same branch, so
  // the journal, payroll and library exports opened in a tab instead of saving
  // under their own filename.
  const out: Record<string, string> = { "Content-Type": ct };
  const cd = res.headers.get("content-disposition");
  if (cd) out["Content-Disposition"] = cd;
  // The API sets this too; repeated here because this is the response the
  // browser actually sees, and a proxy that rebuilds headers owns them.
  out["X-Content-Type-Options"] = "nosniff";
  // NOTHING PROXIED FROM THE API IS A PAGE. Data and downloads have no reason
  // to run script, load an image or be framed, so this response is sandboxed
  // into an opaque origin with everything denied. It is the backstop for the
  // hole above: even served as text/html with the disposition somehow lost
  // again, the document cannot execute or reach anything of ours. The app's own
  // pages are not served from here and are unaffected.
  out["Content-Security-Policy"] = "default-src 'none'; sandbox";
  // AND THIS RESPONSE IS NOT SOMEBODY ELSE'S CACHE ENTRY.
  //
  // Same reasoning as the nosniff line above, and the same reason it is
  // repeated here: the API sets it too, but this proxy REBUILDS the header set
  // from scratch, so whatever it does not name does not reach the browser.
  // Everything through here is one tenant's data, fetched with that user's
  // bearer token, and it went out with no `Cache-Control` and a `Vary` that
  // named only Next's RSC headers. A 200 GET with no freshness information is
  // heuristically cacheable by a shared cache; a school's own network proxy
  // keyed on the URL alone would serve one teacher's `/students` to the next.
  // Nearer to hand: the browser's disk cache and back-button after sign-out, on
  // the shared scan desk and attendance kiosk this product ships.
  out["Cache-Control"] = "private, no-store";
  out["Vary"] = "Cookie";

  // Text/JSON pass through as text; binary (e.g. report-card PDFs) as bytes.
  if (ct.includes("json") || ct.includes("text") || ct.includes("html")) {
    return new NextResponse(await res.text(), { status: res.status, headers: out });
  }
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
