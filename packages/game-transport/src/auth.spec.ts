import { createHmac } from "node:crypto";
import { AuthError, verifyJwt } from "./auth";

const SECRET = "test-shared-auth-secret";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Hand-sign a JWS so the test controls every field (mirrors what Auth.js issues). */
function sign(payload: Record<string, unknown>, secret = SECRET, alg = "HS256"): string {
  const header = b64url({ alg, typ: "JWT" });
  const body = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const claims = {
  userId: "user-123",
  school_id: "school-abc",
  roles: ["student"],
  permissions: ["game.play"],
  name: "Ada Lovelace",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe("verifyJwt — handshake auth (spec §11 step 3)", () => {
  it("accepts a valid HS256 token and projects the principal", () => {
    const p = verifyJwt(sign(claims), SECRET);
    expect(p).toEqual({
      userId: "user-123",
      schoolId: "school-abc",
      roles: ["student"],
      permissions: ["game.play"],
      name: "Ada Lovelace",
    });
  });

  it("supports `sub` / `schoolId` claim aliases and derives a fallback name", () => {
    const p = verifyJwt(sign({ sub: "u-9", schoolId: "s-9" }), SECRET);
    expect(p.userId).toBe("u-9");
    expect(p.schoolId).toBe("s-9");
    expect(p.name).toBe("Player u-9");
    expect(p.roles).toEqual([]);
    expect(p.permissions).toEqual([]);
  });

  it("rejects a tampered signature", () => {
    const tampered = sign(claims).slice(0, -3) + "xyz";
    expect(() => verifyJwt(tampered, SECRET)).toThrow(AuthError);
  });

  it("rejects a token signed with a different secret", () => {
    expect(() => verifyJwt(sign(claims, "other-secret"), SECRET)).toThrow(/invalid signature/);
  });

  it("pins HS256 — rejects alg:none and other algorithms", () => {
    expect(() => verifyJwt(sign(claims, SECRET, "none"), SECRET)).toThrow(/algorithm/);
    expect(() => verifyJwt(sign(claims, SECRET, "HS512"), SECRET)).toThrow(/algorithm/);
  });

  it("rejects an expired or not-yet-valid token", () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    expect(() => verifyJwt(sign(expired), SECRET)).toThrow(/expired/);
    const future = { ...claims, nbf: Math.floor(Date.now() / 1000) + 1000 };
    expect(() => verifyJwt(sign(future), SECRET)).toThrow(/not yet valid/);
  });

  it("rejects a token missing tenant claims, a malformed token, and an empty secret", () => {
    expect(() => verifyJwt(sign({ userId: "u" }), SECRET)).toThrow(/tenant claims/);
    expect(() => verifyJwt("not.a.jwt.token", SECRET)).toThrow(AuthError);
    expect(() => verifyJwt("onlyonepart", SECRET)).toThrow(/malformed/);
    expect(() => verifyJwt(sign(claims), "")).toThrow(/not configured/);
  });
});
