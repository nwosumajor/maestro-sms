// =============================================================================
// The encryption key that was set, and did nothing
// =============================================================================
// A missing DATA_ENCRYPTION_KEY disables field encryption. That was deliberate —
// local work must not need a secret — and it warns. What was not deliberate is
// that a MIS-SET key did the same thing IN SILENCE. Measured against the built
// image, encrypting "penicillin":
//
//   (unset)              plaintext, with the warning
//   32-byte base64       encrypted
//   "c2hvcnQ="           plaintext, NO WARNING       (decodes to 5 bytes)
//   "not-base64-at-all"  plaintext, NO WARNING       (Buffer.from never throws)
//
// The last two are the likely operator mistakes — a truncated secret, a
// placeholder, a passphrase typed where base64 was wanted — and they are exactly
// the cases where somebody BELIEVES the key is set. What goes to plaintext is
// medical records, salaries, payslips, bank details and loan balances: 38 call
// sites across HR, SIS and billing.
//
// In production that now refuses to boot. Unlike a wrong storage provider it
// cannot be repaired by fixing the variable afterwards — the rows are already
// written in the clear.
// =============================================================================

import { assertFieldCryptoConfigured, keyProblem, encryptField } from "../../src/foundation/field-crypto";

const VALID = Buffer.alloc(32, 7).toString("base64");

describe("what counts as a working key", () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.DATA_ENCRYPTION_KEY = originalKey;
    process.env.NODE_ENV = originalEnv;
  });

  it("accepts 32 bytes of base64", () => {
    process.env.DATA_ENCRYPTION_KEY = VALID;
    expect(keyProblem()).toBeNull();
  });

  it("reports an unset key", () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(keyProblem()).toMatch(/unset/);
  });

  it("reports a key that is too short, which used to be silent", () => {
    // "c2hvcnQ=" is "short" — five bytes. It disabled encryption and said
    // nothing, because the warning only ever covered the unset case.
    process.env.DATA_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(keyProblem()).toMatch(/decodes to 5 bytes/);
  });

  it("reports a value that is not base64 at all", () => {
    // Buffer.from(x, "base64") does not throw — it decodes what it can — so a
    // passphrase typed where base64 was wanted yields a short buffer, not an
    // error.
    process.env.DATA_ENCRYPTION_KEY = "not-base64-at-all";
    expect(keyProblem()).not.toBeNull();
  });

  it("says how many bytes it got, so the mistake is obvious", () => {
    process.env.DATA_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(keyProblem()).toMatch(/32 are needed/);
  });
});

describe("what happens at boot", () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.DATA_ENCRYPTION_KEY = originalKey;
    process.env.NODE_ENV = originalEnv;
  });

  it("REFUSES to start in production with a broken key", () => {
    process.env.NODE_ENV = "production";
    process.env.DATA_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(() => assertFieldCryptoConfigured()).toThrow(/Refusing to start/);
  });

  it("refuses in production with no key at all", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => assertFieldCryptoConfigured()).toThrow(/unset/);
  });

  it("says why it cannot simply be fixed later", () => {
    // The reason this is a boot failure and not a warning: the rows are already
    // written in the clear by the time anyone notices.
    process.env.NODE_ENV = "production";
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => assertFieldCryptoConfigured()).toThrow(/does not undo that/);
  });

  it("still starts outside production, so local work needs no secret", () => {
    // The original decision, kept where it was right.
    process.env.NODE_ENV = "test";
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => assertFieldCryptoConfigured()).not.toThrow();
  });

  it("starts in production when the key works", () => {
    process.env.NODE_ENV = "production";
    process.env.DATA_ENCRYPTION_KEY = VALID;
    expect(() => assertFieldCryptoConfigured()).not.toThrow();
    expect(encryptField("penicillin", "school-1")).toMatch(/^enc:v1:/);
  });
});
