// =============================================================================
// A key that looked exactly right, and was printed in the repository
// =============================================================================
// Validating a secret's SHAPE is not validating a secret. `.env.example` shipped
//
//   DATA_ENCRYPTION_KEY=Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=
//
// a perfectly well-formed 32-byte base64 key that passes every malformed-key
// check added the day before — and is published here. A deployment that copied
// the example encrypts medical records, salaries, payslips and bank details with
// a key anyone can read from the source: the ciphertext is real, the protection
// is not. On this machine that was 13 salary rows and 1 medical record.
//
// AUTH_SECRET had the same problem in a cruder form, and a pattern caught it.
// No pattern catches this one, because it looks exactly like what it should be.
// The only thing that distinguishes it is that we published it.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPublishedSecret, PUBLISHED_SECRETS } from "../../src/auth/published-secrets";
import { secretProblem } from "../../src/auth/secrets";
import { keyProblem } from "../../src/foundation/field-crypto";

const EXAMPLE = readFileSync(join(__dirname, "../../../../infrastructure/.env.example"), "utf8");

describe("a value this repository has published", () => {
  it("is recognised however well-formed it looks", () => {
    expect(isPublishedSecret("Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=")).toBe(true);
  });

  it("is rejected as an encryption key", () => {
    const original = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = "Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=";
    try {
      // 32 bytes of valid base64 — every shape check passes. Only provenance
      // separates it from a real key.
      expect(Buffer.from(process.env.DATA_ENCRYPTION_KEY, "base64").length).toBe(32);
      expect(keyProblem()).toMatch(/published/);
    } finally {
      process.env.DATA_ENCRYPTION_KEY = original;
    }
  });

  it("is rejected as a signing secret", () => {
    const original = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "change-me-32-char-min-secret";
    try {
      expect(secretProblem()).not.toBeNull();
    } finally {
      process.env.AUTH_SECRET = original;
    }
  });

  it("lets an unpublished value of the same shape through", () => {
    // The check must be provenance, not "any base64 key looks suspicious".
    const original = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    try {
      expect(keyProblem()).toBeNull();
    } finally {
      process.env.DATA_ENCRYPTION_KEY = original;
    }
  });
});

describe("the list cannot fall behind the file that creates the problem", () => {
  it("registers every secret-looking value the example still ships", () => {
    // The example is the source of published secrets. If somebody adds a new one
    // with a real-looking value, this fails until it is registered — and then the
    // boot checks refuse it in production.
    const shipped = [...EXAMPLE.matchAll(/^([A-Z_]*(?:SECRET|KEY|PASSWORD|TOKEN))=(.+)$/gm)]
      .map((m) => ({ name: m[1], value: m[2].trim() }))
      .filter((v) => v.value.length > 0 && !v.value.startsWith("#"));
    const unregistered = shipped.filter((v) => !isPublishedSecret(v.value)).map((v) => v.name);
    expect(unregistered).toEqual([]);
  });

  it("never removes a value once published", () => {
    // A value stays compromised after the example stops carrying it: the
    // deployments that copied it still have it, which is exactly who this
    // protects. Both values removed from the example today are still listed.
    expect(PUBLISHED_SECRETS).toContain("change-me-32-char-min-secret");
    expect(PUBLISHED_SECRETS).toContain("Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=");
  });

  it("no longer ships a working encryption key", () => {
    expect(EXAMPLE).toMatch(/^DATA_ENCRYPTION_KEY=\s*$/m);
    expect(EXAMPLE).toMatch(/does NOT re-protect existing rows/);
  });
});
