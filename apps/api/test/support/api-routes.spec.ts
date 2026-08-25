// =============================================================================
// The extractor six gates depend on
// =============================================================================
// It is now a shared dependency, so a quiet regression in it goes quiet in six
// places at once. These cases pin the three things that were actually wrong in
// the private copies it replaced.
// =============================================================================

import { apiRoutes, controllerPrefixAt, joinRoute } from "./api-routes";

const routes = apiRoutes();
const keys = new Set(routes.map((r) => r.key));

describe("the shared route extractor", () => {
  it("found the API, so a matcher that quietly matches nothing cannot pass", () => {
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.filter((r) => r.permissions.length > 0).length).toBeGreaterThan(400);
  });

  describe("resolves each route against its OWN controller", () => {
    // Three files declare two controllers. Taking the first put four routes
    // under a path nobody can call, and one of them then matched a named
    // exemption written against that fiction.
    it.each([
      ["POST /public/careers/:slug/apply", "POST /hr/recruitment/:slug/apply"],
      ["POST /public/biometric/:slug/events", "POST /hr/attendance/:slug/events"],
      ["GET /students/profile-reviews", "GET /students/:studentId/profile-reviews"],
    ])("%s, and never %s", (real, fictional) => {
      expect([keys.has(real), keys.has(fictional)]).toEqual([true, false]);
    });
  });

  it("reads decorators written ABOVE the route, not only below", () => {
    // `@Public()` is written above `@Post(...)`. A block anchored at the route
    // decorator reported false for every public route that matters.
    for (const key of [
      "POST /public/careers/:slug/apply",
      "POST /public/biometric/:slug/events",
      "POST /payments/webhook",
    ]) {
      expect([key, routes.find((r) => r.key === key)?.isPublic]).toEqual([key, true]);
    }
    expect(routes.filter((r) => r.isPublic).length).toBeGreaterThan(20);
  });

  it("splits a multi-argument @RequirePermission", () => {
    // `@RequirePermission(A, B)` grants on either. Read as one opaque string it
    // compared equal to nothing but itself, so such a route could sit outside a
    // consistency rule that covered all of its siblings.
    const multi = routes.filter((r) => r.permissions.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const r of multi) {
      for (const p of r.permissions) {
        expect([r.key, p, /^[A-Za-z_][\w.]*$/.test(p)]).toEqual([r.key, p, true]);
      }
    }
  });

  it("keeps decorator questions and handler questions apart", () => {
    // `block` is the decorator run; `body` is the handler. Conflating them made
    // the audit gate extract zero routes while still reporting no offenders.
    const withCall = routes.filter((r) => /this\.\w+\.\w+\(/.test(r.body));
    expect(withCall.length).toBeGreaterThan(400);
  });

  it("normalises paths without doubling or dropping separators", () => {
    expect(joinRoute("hr/attendance", "mark")).toBe("/hr/attendance/mark");
    expect(joinRoute("", "health")).toBe("/health");
    expect(joinRoute("students/:studentId", "")).toBe("/students/:studentId");
    expect(controllerPrefixAt(`@Controller("a")\nx\n@Controller("b")\ny`, 0)).toBe("a");
  });
});
