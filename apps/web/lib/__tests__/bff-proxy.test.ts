// =============================================================================
// Two proxies, one of them left behind
// =============================================================================
// Every browser request reaches the API through one of two same-origin proxies:
//
//   /api/sms/*     authenticated — mints a Bearer from the session server-side,
//                  so the browser never holds a verifiable API token
//   /api/public/*  unauthenticated — the @Public surface
//
// The public one passes the request's ORIGINAL content type through and forwards
// raw bytes, because a multipart upload carries its boundary in that header. It
// was fixed to do so when the careers CV upload needed it.
//
// The authenticated one hard-coded `application/json` and re-encoded the body as
// text. That is not a live fault: nothing authenticated sends multipart today,
// since document uploads go straight to object storage on a presigned URL. It is
// a TRAP. The first authenticated file upload would arrive at the API as
// JSON-labelled text with the boundary gone, and would fail looking like a
// broken endpoint rather than a broken proxy — which is a long afternoon.
//
// Fixing it is cheap and removes the asymmetry: the correct implementation was
// already sitting in the next directory.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");
const BFF = readFileSync(join(WEB, "app/api/sms/[...path]/route.ts"), "utf8");
const PUBLIC = readFileSync(join(WEB, "app/api/public/[...path]/route.ts"), "utf8");

describe("both proxies forward a body the same way", () => {
  it.each([
    ["authenticated", BFF],
    ["public", PUBLIC],
  ])("%s: passes the caller's content type through", (_name, src) => {
    expect(src).toMatch(/headers\["Content-Type"\] = req\.headers\.get\("content-type"\) \?\? "application\/json"/);
  });

  it.each([
    ["authenticated", BFF],
    ["public", PUBLIC],
  ])("%s: forwards raw bytes, not re-encoded text", (_name, src) => {
    expect(src).toMatch(/body = Buffer\.from\(await req\.arrayBuffer\(\)\)/);
    // `await req.text()` would silently corrupt any binary body.
    expect(src).not.toMatch(/body = await req\.text\(\)/);
  });
});

describe("what the authenticated proxy must keep doing", () => {
  it("mints the token server-side and never trusts one from the browser", () => {
    // The whole reason this proxy exists: AUTH_SECRET stays on the server.
    expect(BFF).toMatch(/const token = await bearerForSession\(\)/);
    expect(BFF).toMatch(/Authorization: `Bearer \$\{token\}`/);
    // It must not relay an Authorization header the client supplied.
    expect(BFF).not.toMatch(/req\.headers\.get\("authorization"\)/i);
  });

  it("refuses without a session rather than forwarding anonymously", () => {
    expect(BFF).toMatch(/if \(!token\) return new NextResponse\("Unauthorized", \{ status: 401 \}\)/);
  });

  it("forwards the client's address, so rate limits mean something", () => {
    // Without it every request looks like it came from the web task, and the
    // API's per-IP bucket covers the whole world at once.
    expect(BFF).toMatch(/forwardedFor\(req\)/);
  });

  it("forwards the step-up token for sensitive routes", () => {
    expect(BFF).toMatch(/const stepup = req\.headers\.get\("x-stepup"\)/);
  });

  it("still returns binary responses as bytes", () => {
    // Report-card and receipt PDFs come back through here.
    expect(BFF).toMatch(/await res\.arrayBuffer\(\)/);
    expect(BFF).toMatch(/Content-Disposition/);
  });
});
