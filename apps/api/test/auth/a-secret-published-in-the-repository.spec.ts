// =============================================================================
// The signing key that was printed in the example file
// =============================================================================
// AUTH_SECRET signs EVERY token this platform issues: session bearers, the
// ws-ticket, step-up tokens, invite links, password-reset links and the local
// storage presigns. It failed closed when absent — `signingSecret()` throws —
// and was otherwise unchecked.
//
// `.env.example` shipped:
//
//   AUTH_SECRET=change-me-32-char-min-secret
//
// which is PUBLISHED IN THIS REPOSITORY, is twenty-eight bytes despite its own
// "32-char-min" advice, and was the value the local stack was actually running.
// Any deployment that copied the example — the ordinary way to start — could
// have its sessions minted by anyone who had read the source: a token for any
// user in any school, a step-up token to pass re-auth, a password-reset link.
//
// That is the same shape as the demo-seed password this project already treats
// as a full platform compromise. It is closed the same way: refuse in
// production, warn everywhere else, and stop shipping a value that looks usable.
// =============================================================================

import { assertAuthSecretUsable, secretProblem } from "../../src/auth/secrets";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GOOD = "y".repeat(32);

describe("what counts as a signing secret", () => {
  const original = process.env.AUTH_SECRET;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.AUTH_SECRET = original;
    process.env.NODE_ENV = originalEnv;
  });

  it("accepts 32 bytes of something unguessable", () => {
    process.env.AUTH_SECRET = GOOD;
    expect(secretProblem()).toBeNull();
  });

  it("rejects the example placeholder by name", () => {
    // Reported by PROVENANCE now — it is on the published list — rather than by
    // the pattern. Both messages say the same thing; the provenance check runs
    // first because it is the stronger claim.
    process.env.AUTH_SECRET = "change-me-32-char-min-secret";
    expect(secretProblem()).toMatch(/published/);
  });

  it("rejects placeholders generally, not just that exact string", () => {
    // Somebody who edits the example will edit it to something like this.
    for (const v of ["changeme", "CHANGE-ME-PLEASE", "secret", "dev", "test", "password123"]) {
      process.env.AUTH_SECRET = v;
      expect([v, secretProblem()]).not.toEqual([v, null]);
    }
  });

  it("rejects a LONG placeholder, which length alone would let through", () => {
    // The discriminating case. Every short placeholder is caught by the length
    // rule anyway, so without this the placeholder rule would only be changing
    // the wording — and somebody editing the example to something longer would
    // sail past.
    process.env.AUTH_SECRET = "change-me-this-one-is-definitely-long-enough-now";
    expect(process.env.AUTH_SECRET.length).toBeGreaterThan(32);
    expect(secretProblem()).toMatch(/placeholder/);
  });

  it("rejects a short secret, and says how short", () => {
    process.env.AUTH_SECRET = "y".repeat(20);
    expect(secretProblem()).toMatch(/20 bytes; 32 is the minimum/);
  });

  it("rejects an unset secret", () => {
    delete process.env.AUTH_SECRET;
    expect(secretProblem()).toMatch(/not set/);
  });

  it("counts BYTES, not characters", () => {
    // 31 multi-byte characters is well over 32 bytes and fine; 31 ASCII is not.
    process.env.AUTH_SECRET = "é".repeat(31);
    expect(secretProblem()).toBeNull();
    process.env.AUTH_SECRET = "y".repeat(31);
    expect(secretProblem()).not.toBeNull();
  });
});

describe("what happens at boot", () => {
  const original = process.env.AUTH_SECRET;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.AUTH_SECRET = original;
    process.env.NODE_ENV = originalEnv;
  });

  it("REFUSES to start in production on the published placeholder", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_SECRET = "change-me-32-char-min-secret";
    expect(() => assertAuthSecretUsable()).toThrow(/Refusing to start/);
  });

  it("says how to generate a real one", () => {
    // A refusal that does not say what to do next is a support ticket.
    process.env.NODE_ENV = "production";
    process.env.AUTH_SECRET = "short";
    expect(() => assertAuthSecretUsable()).toThrow(/openssl rand -base64 32/);
  });

  it("still starts outside production, so local work needs no generated key", () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_SECRET = "change-me-32-char-min-secret";
    expect(() => assertAuthSecretUsable()).not.toThrow();
  });

  it("starts in production on a real secret", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_SECRET = GOOD;
    expect(() => assertAuthSecretUsable()).not.toThrow();
  });
});

describe("the example file", () => {
  it("no longer ships a value that looks usable", () => {
    // The failure was not only that the value was weak: it was that copying the
    // example gave you a WORKING stack, so nothing ever forced the question.
    const example = readFileSync(join(__dirname, "../../../../infrastructure/.env.example"), "utf8");
    expect(example).toMatch(/^AUTH_SECRET=\s*$/m);
    expect(example).toMatch(/openssl rand -base64 32/);
  });
});
