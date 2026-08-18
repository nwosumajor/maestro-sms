// =============================================================================
// The web tier is the only way in — audited, and the subtle part pinned
// =============================================================================
// A phase spent on the front door: everything reachable from a browser before
// the API's guards get a say. No defect found, and this records WHY so it is
// not re-derived — and pins the one property that is easy to "fix" back into a
// vulnerability.
//
// THE SUBTLE ONE. The API rate-limits per IP, and the browser never speaks to
// it. Each trusted proxy APPENDS the peer it observed to `x-forwarded-for`, so
// the RIGHTMOST entry is the only one a caller cannot forge. That is the
// reverse of the usual advice ("the first entry is the client"), which assumes
// the header is read at the edge — and someone applying that advice here would
// silently reopen the hole. Verified live through the real stack: fifteen
// password-reset requests each claiming a different address, against a limit of
// five, gave 5 accepted and 10 refused.
//
// THE REST, checked and sound:
//   - the authenticated BFF requires a session token and forwards exactly four
//     headers: Authorization (server-minted), x-forwarded-for, x-stepup, and
//     the original Content-Type;
//   - its target is `${API_BASE}/${path}`, so a path segment cannot change the
//     HOST — the worst a caller can do is name another API route, which the
//     API's own guards then judge;
//   - the PUBLIC proxy is prefix-constrained to `${API_BASE}/public/…`, and
//     traversal does not escape it: `%2e%2e/metrics`, `..%2fmetrics`,
//     `%2e%2e%2fmetrics` and `a/%2e%2e/%2e%2e/metrics` all answered 404/403
//     through the real stack while `plan-pricing` answered 200;
//   - the WEBHOOKS proxy is an explicit allowlist with its own pinning test;
//   - docker-compose publishes NO ports for backend, frontend, postgres or
//     redis — only nginx — and nginx sets `$proxy_add_x_forwarded_for`, which
//     appends. The trust boundary the rightmost rule depends on is real.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientIp } from "../../src/common/client-ip";

const WEB = (p: string) => readFileSync(join(__dirname, "../../../web", p), "utf8");

const withHeader = (xff: string) => ({ headers: { "x-forwarded-for": xff }, ip: "10.9.9.9" });

describe("which hop the limiter believes", () => {
  it("takes the RIGHTMOST entry — the one our proxy appended", () => {
    expect(clientIp(withHeader("1.2.3.4, 5.6.7.8, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("ignores a forged entry the caller prepended", () => {
    // nginx APPENDS the real peer, so anything the caller typed sits to the
    // LEFT of it and cannot displace it.
    const forged = clientIp(withHeader("evil-claims-this, 203.0.113.9"));
    expect(forged).toBe("203.0.113.9");
    expect(forged).not.toBe("evil-claims-this");
  });

  it("cannot be fooled by rotating the forged part", () => {
    // The live proof of this was 5 accepted / 10 refused out of fifteen
    // requests each claiming a different address.
    const buckets = new Set(
      Array.from({ length: 15 }, (_, i) => clientIp(withHeader(`10.0.0.${i}, 203.0.113.9`))),
    );
    expect(buckets.size).toBe(1);
  });

  it("handles a header arriving as an array", () => {
    expect(clientIp({ headers: { "x-forwarded-for": ["1.1.1.1", "203.0.113.9"] } })).toBe("203.0.113.9");
  });

  it("tolerates whitespace and empty hops rather than bucketing everyone as ''", () => {
    expect(clientIp(withHeader("1.1.1.1 ,  , 203.0.113.9 ,"))).toBe("203.0.113.9");
  });

  it("falls back to the socket peer when there is no header at all", () => {
    expect(clientIp({ ip: "198.51.100.7", headers: {} })).toBe("198.51.100.7");
    expect(clientIp({ socket: { remoteAddress: "198.51.100.8" }, headers: {} })).toBe("198.51.100.8");
  });

  it("never returns empty — an empty bucket is one bucket for everyone", () => {
    expect(clientIp({ headers: {} })).toBe("unknown");
  });
});

describe("what the web tier passes on", () => {
  const BFF = WEB("app/api/sms/[...path]/route.ts");

  it("forwards the client's address at all", () => {
    // Without it the API saw one peer for every request on earth and the
    // per-IP limiter became a per-route global one.
    expect(BFF).toMatch(/\.\.\.forwardedFor\(req\)/);
  });

  it("passes the header through rather than rebuilding it", () => {
    // Rebuilding from the leftmost entry is exactly the forgeable version.
    const fwd = WEB("lib/forwarded.ts");
    expect(fwd).toMatch(/req\?\.headers\?\.get\("x-forwarded-for"\)/);
    expect(fwd).not.toMatch(/split\(","\)\s*\[0\]/);
  });

  it("mints the Authorization itself and does not echo the client's", () => {
    expect(BFF).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(BFF).not.toMatch(/req\.headers\.get\("authorization"\)/i);
  });

  it("refuses without a session", () => {
    expect(BFF).toMatch(/if \(!token\) return new NextResponse\("Unauthorized", \{ status: 401 \}\)/);
  });
});

describe("the unauthenticated doors", () => {
  it("the public proxy can only reach /public/…", () => {
    expect(WEB("app/api/public/[...path]/route.ts")).toMatch(/\$\{API_BASE\}\/public\//);
  });

  it("the webhook proxy is an allowlist, not a general opening", () => {
    const hooks = WEB("app/api/webhooks/[...path]/route.ts");
    expect(hooks).toMatch(/ALLOWLIST, not a general opening/);
    expect(hooks).toMatch(/if \(!target\) return NextResponse\.json\(\{ error: "Unknown webhook" \}, \{ status: 404 \}\)/);
  });
});
