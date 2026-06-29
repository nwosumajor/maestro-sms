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

  it("prefers the forwarded client IP (x-forwarded-for) over the peer", () => {
    const guard = new RateLimitGuard(1, 60_000);
    const mk = (xff: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ ip: "10.0.0.1", headers: { "x-forwarded-for": xff }, route: { path: "/p" }, method: "POST" }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(mk("203.0.113.5, 10.0.0.1"))).toBe(true);
    expect(() => guard.canActivate(mk("203.0.113.5"))).toThrow(); // same real client -> blocked
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
