// =============================================================================
// A gateway that never answers must not hold a queue for ever
// =============================================================================
// Node's `fetch` has no default timeout. Every outbound call in this codebase
// handles a gateway that REFUSES the connection; none handled one that accepts
// it and then goes quiet, which is the commoner failure under load.
//
// It matters here more than it usually would because these calls are made from
// BullMQ workers that run one job at a time. A hung request never rejects, so
// it is never caught, never retried, never logged and never alerted — it simply
// holds that queue's only slot until the process restarts. The mobile-money
// recovery sweep is the sharpest case: it is the ONLY thing that closes a
// payment whose callback was lost, and its per-intent poll sits inside a catch
// commented "one rail being down must not stop the sweep for the others",
// which a hang walks straight past.
// =============================================================================

import { createServer, Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchWithTimeout, GATEWAY_TIMEOUT_MS } from "../../src/common/http";

describe("fetchWithTimeout", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // Accepts the connection, reads the request, and then says nothing at all —
    // exactly what an overloaded gateway does.
    server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/hang`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  });

  it("gives up on a server that never answers", async () => {
    const started = Date.now();
    await expect(fetchWithTimeout(url, {}, 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("rejects rather than hanging, so the caller's existing catch fires", async () => {
    // This is the whole mechanism: every call site already handles a rejection.
    // The fix is not new error handling — it is turning a hang into a rejection
    // the existing handling can see.
    let caught: unknown = null;
    try {
      await fetchWithTimeout(url, {}, 300);
    } catch (err) {
      caught = err;
    }
    // A DOMException, NOT an Error — worth pinning, because every call site
    // logs `(err as Error).message` and that is the property they rely on.
    expect(caught).toBeTruthy();
    expect((caught as Error).name).toBe("TimeoutError");
    expect(typeof (caught as Error).message).toBe("string");
    expect((caught as Error).message).toMatch(/timeout/i);
  });

  it("lets a caller's own deadline win", async () => {
    // testConnection on both card rails sets its own 10s; the helper must not
    // silently overrule a caller that has thought about it.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const started = Date.now();
    await expect(fetchWithTimeout(url, { signal: ctrl.signal }, 60_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("passes the response through untouched when the server does answer", async () => {
    const ok = createServer((_q, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: true }));
    });
    await new Promise<void>((r) => ok.listen(0, "127.0.0.1", r));
    const a = ok.address();
    const res = await fetchWithTimeout(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
    await new Promise<void>((r) => ok.close(() => r()));
  });

  it("has a deadline long enough for a real gateway", () => {
    expect(GATEWAY_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(GATEWAY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("no call leaves the building without a deadline", () => {
  // The DRIFT GUARD, and the real lesson. There was no shared helper, so every
  // call site hand-rolled its options — and the two rails that did think about
  // it gave 10 seconds to `/balance`, a diagnostic nobody's money depends on,
  // and nothing at all to transaction/initialize, verify, refund or
  // charge_authorization. Nobody decided that; it is what happens when each
  // call site is written alone. A new one must not be able to reintroduce it.
  const SRC = join(__dirname, "../../src");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("every outbound call in apps/api goes through fetchWithTimeout", () => {
    const offenders = walk(SRC)
      .filter((p) => !p.endsWith(join("common", "http.ts")))
      .filter((p) => /(?<![.\w])fetch\s*\(/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1));
    // A walk that finds nothing produces no offenders and passes with a green
    // tick. The magnitude is the only thing that tells "clean" from "blind" —
    // see a-gate-must-not-pass-by-finding-nothing.
    expect(walk(SRC).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("covers the rails that actually move money", () => {
    // Named so a file being deleted or renamed cannot quietly empty the guard
    // above into a test that asserts nothing.
    for (const f of [
      "payments/paystack.service.ts",
      "payments/stripe.service.ts",
      "payments/mobile-money.provider.ts",
      "notifications/email.service.ts",
      "notifications/twilio-channel.provider.ts",
    ]) {
      expect(readFileSync(join(SRC, f), "utf8")).toContain("fetchWithTimeout(");
    }
  });
});
