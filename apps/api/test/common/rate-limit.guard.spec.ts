// =============================================================================
// RateLimitGuard — per-IP sliding-window unit tests
// =============================================================================
// Backstop for unauthenticated public intake: the Nth+1 request from the same IP
// within the window is rejected with 429; a different IP is independent; old hits
// age out of the window.

import { HttpException, type ExecutionContext } from "@nestjs/common";
import { RateLimitGuard } from "../../src/common/rate-limit.guard";

function ctxFor(ip: string, path = "/public/admissions", method = "POST"): ExecutionContext {
  const req = { ip, headers: {}, route: { path }, method };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  it("allows up to the limit then throws 429 for the same IP", () => {
    const guard = new RateLimitGuard(3, 60_000);
    const ctx = ctxFor("1.1.1.1");
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    try {
      guard.canActivate(ctx);
      throw new Error("expected 429");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  it("tracks IPs independently", () => {
    const guard = new RateLimitGuard(1, 60_000);
    expect(guard.canActivate(ctxFor("1.1.1.1"))).toBe(true);
    expect(guard.canActivate(ctxFor("2.2.2.2"))).toBe(true); // different IP, own bucket
    expect(() => guard.canActivate(ctxFor("1.1.1.1"))).toThrow(); // first IP exhausted
  });

  // THIS TEST USED TO ASSERT THE BUG.
  //
  // It read the LEFTMOST forwarded entry as the client and pinned that:
  // "203.0.113.5, 10.0.0.1" and "203.0.113.5" were treated as the same caller.
  // But nginx is configured with `$proxy_add_x_forwarded_for`, which APPENDS the
  // peer it observed — so the leftmost entry is whatever the caller typed, and
  // the limiter could be bypassed with a single header. Proved live: rotating a
  // prepended value put 15 of 15 login attempts through a limit of 10.
  //
  // The rule is the reverse: the RIGHTMOST entry is the one our own proxy
  // appended, and the only one a caller cannot forge.
  it("identifies the client by the RIGHTMOST forwarded entry, not the first", () => {
    const guard = new RateLimitGuard(1, 60_000);
    const mk = (xff: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ ip: "10.0.0.1", headers: { "x-forwarded-for": xff }, route: { path: "/p" }, method: "POST" }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(mk("9.9.9.9, 203.0.113.5"))).toBe(true);
    expect(() => guard.canActivate(mk("1.1.1.1, 203.0.113.5"))).toThrow();
  });

  it("cannot be bypassed by rotating a prepended value", () => {
    const guard = new RateLimitGuard(3, 60_000);
    const mk = (xff: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ ip: "10.0.0.1", headers: { "x-forwarded-for": xff }, route: { path: "/p" }, method: "POST" }) }) }) as unknown as ExecutionContext;
    // The attack, exactly: a new prefix every request, one real client behind it.
    expect(guard.canActivate(mk("9.9.9.1, 203.0.113.5"))).toBe(true);
    expect(guard.canActivate(mk("9.9.9.2, 203.0.113.5"))).toBe(true);
    expect(guard.canActivate(mk("9.9.9.3, 203.0.113.5"))).toBe(true);
    expect(() => guard.canActivate(mk("9.9.9.4, 203.0.113.5"))).toThrow();
  });

  it("still gives genuinely different clients their own bucket", () => {
    // The other failure direction: over-keying would let one attacker lock
    // everybody else out of sign-in.
    const guard = new RateLimitGuard(1, 60_000);
    const mk = (xff: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ ip: "10.0.0.1", headers: { "x-forwarded-for": xff }, route: { path: "/p" }, method: "POST" }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(mk("198.51.100.1"))).toBe(true);
    expect(guard.canActivate(mk("198.51.100.2"))).toBe(true);
  });

  it("ages hits out of the window", () => {
    const guard = new RateLimitGuard(1, 50);
    const ctx = ctxFor("9.9.9.9");
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(guard.canActivate(ctx)).toBe(true); // window elapsed
        resolve();
      }, 70);
    });
  });
});
