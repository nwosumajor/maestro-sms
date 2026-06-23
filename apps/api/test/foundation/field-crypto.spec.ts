// =============================================================================
// Field-level encryption — round-trip, per-tenant key isolation, passthrough
// =============================================================================

import { encryptField, decryptField, encryptionEnabled } from "../../src/foundation/field-crypto";

const KEY = "Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE="; // 32 bytes base64

describe("field-crypto", () => {
  const schoolA = "11111111-1111-1111-1111-111111111111";
  const schoolB = "22222222-2222-2222-2222-222222222222";

  beforeAll(() => { process.env.DATA_ENCRYPTION_KEY = KEY; });

  it("round-trips a value for a tenant", () => {
    const blob = encryptField("peanut allergy", schoolA);
    expect(blob).toMatch(/^enc:v1:/);
    expect(blob).not.toContain("peanut");
    expect(decryptField(blob, schoolA)).toBe("peanut allergy");
  });

  it("a different tenant's key cannot read the ciphertext", () => {
    const blob = encryptField("epilepsy", schoolA);
    // Wrong key -> auth tag fails -> returns "" (never leaks ciphertext as text).
    expect(decryptField(blob, schoolB)).toBe("");
  });

  it("passes through null and legacy plaintext", () => {
    expect(encryptField(null, schoolA)).toBeNull();
    expect(decryptField("just plaintext", schoolA)).toBe("just plaintext");
  });

  it("is disabled (plaintext) when no key is configured", () => {
    const saved = process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(encryptionEnabled()).toBe(false);
    expect(encryptField("x", schoolA)).toBe("x");
    process.env.DATA_ENCRYPTION_KEY = saved;
  });
});
