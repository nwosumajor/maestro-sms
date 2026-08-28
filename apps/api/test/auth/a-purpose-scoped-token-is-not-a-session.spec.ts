// =============================================================================
// A purpose-scoped token is not a session
// =============================================================================
// `verifyToken` accepted `sub` for `userId` and `schoolId` for `school_id` and
// checked nothing else — which is the shape of EVERY other token this platform
// signs with the same secret:
//
//   invite            { sub, school_id, purpose: "invite"   }   7 days, in a URL
//   password reset    { sub, school_id, purpose: "pwreset"  }  30 min,  in a URL
//   step-up           { sub, schoolId,  typ: "stepup"       }   5 min,  a header
//   document upload   { sub, school_id, purpose: "doc-upload" } 7 days, in a URL
//
// So all four authenticated as sessions. Measured live with an invite token as
// `Authorization: Bearer`:
//
//   garbage token       -> 401
//   wrong-secret token  -> 401
//   INVITE token        -> 403   (denied on PERMISSIONS — it had authenticated)
//   GET /auth/refresh   -> 200, roles ["teacher"], 56 permissions
//
// A forwarded invite email, a link in browser history or a shared device
// therefore yielded the target's FULL authority for seven days — and kept doing
// so after the invite was used, because single-use is enforced at the accept
// endpoint (`passwordChangedAt IS NULL`), which that path never touches.
//
// `invite.ts` states the property as already holding: "a session JWT can never
// be replayed here (AND VICE VERSA — the API pins algorithms + checks the
// purpose)". The first half was enforced. The vice versa was not.
// =============================================================================

import jwt from "jsonwebtoken";
import { verifyToken } from "../../src/auth/jwt";

// The secret is read per call (`process.env.AUTH_SECRET` inside
// `verifyingSecrets`), so setting it here is enough — no module reset needed.
const SECRET = "a-test-secret-that-is-at-least-thirty-two-bytes-long";
process.env.AUTH_SECRET = SECRET;
const U = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const sign = (claims: Record<string, unknown>) =>
  jwt.sign(claims, SECRET, { algorithm: "HS256", expiresIn: "5m" });

describe("verifyToken", () => {
  it("accepts a real session bearer — exactly what apps/web mints", () => {
    // The half that must not be traded away: userId/school_id/roles, no marker.
    const p = verifyToken(sign({ userId: U, school_id: S, roles: ["teacher"] }));
    expect(p).toMatchObject({ userId: U, schoolId: S, roles: ["teacher"] });
  });

  it("accepts an impersonation token, which is a genuine session", () => {
    const p = verifyToken(sign({ userId: U, school_id: S, roles: ["teacher"], imp: { by: "owner-1" } }));
    expect(p.impersonatedBy).toBe("owner-1");
  });

  it("REFUSES every purpose-scoped token, whichever claim carries the marker", () => {
    const scoped = [
      { sub: U, school_id: S, purpose: "invite" },
      { sub: U, school_id: S, purpose: "pwreset", pca: 0 },
      { sub: U, schoolId: S, typ: "stepup" },
      { sub: U, school_id: S, purpose: "doc-upload" },
    ];
    for (const claims of scoped) {
      expect(() => verifyToken(sign(claims))).toThrow();
    }
  });

  it("refuses a marker it has never heard of", () => {
    // The check is on the MARKER, not on a list of known values. A list is one
    // that a new token kind gets added without — and this rule has to hold for
    // tokens nobody has written yet.
    expect(() => verifyToken(sign({ sub: U, school_id: S, purpose: "some-future-flow" }))).toThrow();
    expect(() => verifyToken(sign({ sub: U, school_id: S, typ: "whatever" }))).toThrow();
  });

  it("is indistinguishable from a forged token, so it is no oracle", () => {
    // Both must be the same generic failure: a caller must not learn that their
    // token was VALID but of the wrong kind.
    const scopedErr = (() => { try { verifyToken(sign({ sub: U, school_id: S, purpose: "invite" })); } catch (e) { return (e as Error).message; } })();
    const forgedErr = (() => { try { verifyToken(jwt.sign({ userId: U, school_id: S }, "a-totally-different-secret")); } catch (e) { return (e as Error).message; } })();
    expect(scopedErr).toBe(forgedErr);
  });

  it("still refuses a token with no tenant claims at all", () => {
    expect(() => verifyToken(sign({ roles: ["teacher"] }))).toThrow();
  });
});
