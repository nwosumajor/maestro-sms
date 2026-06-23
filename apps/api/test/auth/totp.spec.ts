// =============================================================================
// TOTP (RFC 6238) — verify the hand-rolled implementation against a known vector
// and its own round-trip / skew-window behaviour.
// =============================================================================

import { generateSecret, totp, verifyTotp, otpauthUri } from "../../src/auth/totp";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    // RFC 6238 Appendix B: ASCII secret "12345678901234567890" at T=59s -> 94287082.
    const base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of that ASCII secret
    expect(totp(base32, 59_000)).toBe("287082");
  });

  it("round-trips: a freshly generated code verifies", () => {
    const secret = generateSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), 1, now)).toBe(true);
  });

  it("accepts a code from the adjacent window (clock skew)", () => {
    const secret = generateSecret();
    const now = Date.now();
    const prev = totp(secret, now - 30_000);
    expect(verifyTotp(secret, prev, 1, now)).toBe(true);
  });

  it("rejects a wrong / malformed code", () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "abc")).toBe(false);
  });

  it("builds a scannable otpauth URI", () => {
    const uri = otpauthUri("teacher@demo.school", "JBSWY3DPEHPK3PXP");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });
});
