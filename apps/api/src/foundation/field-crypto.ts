// =============================================================================
// Field-level encryption — envelope, per-tenant key, AES-256-GCM (node crypto)
// =============================================================================
// Defense-in-depth BEYOND RLS: the most sensitive PII (medical fields) is stored
// ENCRYPTED, so a DB dump or an RLS bypass still yields ciphertext. A master key
// (DATA_ENCRYPTION_KEY, 32 bytes base64) is split per-tenant via HKDF(schoolId),
// so one school's data can't be decrypted with another's derived key. Ciphertext
// is tagged "enc:v1:"; decrypt passes through anything else (legacy plaintext) so
// existing rows keep working.
//
// A MISSING KEY DISABLES ENCRYPTION, and that was deliberate — local work must
// not need a secret. What was not deliberate is that a MIS-SET key did the same
// thing IN SILENCE. Measured against the built image:
//
//   (unset)              plaintext, with the warning
//   32-byte base64       encrypted
//   "c2hvcnQ="           plaintext, NO WARNING       (decodes to 5 bytes)
//   "not-base64-at-all"  plaintext, NO WARNING       (Buffer.from never throws)
//
// The second pair are the likely operator mistakes — a truncated secret, a
// placeholder, a passphrase typed where base64 was wanted — and they are exactly
// the cases where somebody BELIEVES the key is set. What goes to plaintext is
// medical records, salaries, payslips, bank details and loan balances.
//
// // SECURITY: so in PRODUCTION an absent or invalid key now REFUSES TO BOOT
// (assertFieldCryptoConfigured, called from main.ts). Unlike a wrong storage
// provider, this cannot be repaired by fixing the variable afterwards — the rows
// are already written in the clear. Outside production the permissive behaviour
// stays, and BOTH failures now warn, naming which one it is.
// =============================================================================

import crypto from "node:crypto";

const PREFIX = "enc:v1:";
let warned = false;

function masterKey(): Buffer | null {
  const problem = keyProblem();
  if (problem) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console -- reason: boot-time security notice
      console.warn(`[field-crypto] ${problem} — field encryption DISABLED.`);
    }
    return null;
  }
  return Buffer.from(process.env.DATA_ENCRYPTION_KEY as string, "base64").subarray(0, 32);
}

/**
 * What is wrong with the configured key, or null if nothing is.
 *
 * The INVALID case is the one this exists for. It used to return null down the
 * same path as "no key at all" but without the warning, so a truncated secret or
 * a passphrase typed where base64 was wanted disabled encryption in silence.
 * `Buffer.from(x, "base64")` never throws — it decodes what it can — so a
 * plain-text value yields a short buffer rather than an error.
 */
export function keyProblem(): string | null {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return "DATA_ENCRYPTION_KEY unset";
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 32) {
    return `DATA_ENCRYPTION_KEY decodes to ${buf.length} bytes, and 32 are needed (is it base64?)`;
  }
  return null;
}

/**
 * Refuse to start in production without working field encryption.
 *
 * Overturns the original "never a hard failure", deliberately and only for
 * production. That decision protected local work, which the non-production
 * branch still does. What it did not weigh is that plaintext here is medical
 * data on minors — Golden Rule #5 — and that no later fix repairs it, because
 * the rows have already been written in the clear.
 */
export function assertFieldCryptoConfigured(): void {
  const problem = keyProblem();
  if (problem && process.env.NODE_ENV === "production") {
    throw new Error(
      `${problem}. Refusing to start: medical records, salaries, payslips and bank details ` +
        `would be written in plaintext, and fixing the variable later does not undo that.`,
    );
  }
}

function tenantKey(mk: Buffer, schoolId: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", mk, Buffer.from(schoolId), Buffer.from("sms-field-v1"), 32),
  );
}

export function encryptionEnabled(): boolean {
  return masterKey() != null;
}

/** Encrypt a string for a tenant. Null/undefined and (when disabled) plaintext
 *  pass through unchanged. */
export function encryptField<T extends string | null | undefined>(plain: T, schoolId: string): T {
  if (plain == null || plain === "") return plain;
  const mk = masterKey();
  if (!mk) return plain;
  const key = tenantKey(mk, schoolId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (PREFIX + Buffer.concat([iv, tag, ct]).toString("base64")) as T;
}

/** Decrypt a tenant value. Non-ciphertext (legacy plaintext) passes through. */
export function decryptField<T extends string | null | undefined>(blob: T, schoolId: string): T {
  if (blob == null || typeof blob !== "string" || !blob.startsWith(PREFIX)) return blob;
  const mk = masterKey();
  if (!mk) return blob;
  try {
    const key = tenantKey(mk, schoolId);
    const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8") as T;
  } catch {
    // Wrong key / tampered data: never leak ciphertext as if it were plaintext.
    return "" as T;
  }
}

/** Encrypt every string value of an object in place (for a record's PII fields). */
export function encryptFields<T extends Record<string, unknown>>(obj: T, schoolId: string): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string") out[k] = encryptField(out[k] as string, schoolId);
  }
  return out as T;
}

/** Decrypt every string value of an object in place. */
export function decryptFields<T extends Record<string, unknown>>(obj: T, schoolId: string): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string") out[k] = decryptField(out[k] as string, schoolId);
  }
  return out as T;
}
