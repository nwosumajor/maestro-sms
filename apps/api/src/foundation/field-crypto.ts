// =============================================================================
// Field-level encryption — envelope, per-tenant key, AES-256-GCM (node crypto)
// =============================================================================
// Defense-in-depth BEYOND RLS: the most sensitive PII (medical fields) is stored
// ENCRYPTED, so a DB dump or an RLS bypass still yields ciphertext. A master key
// (DATA_ENCRYPTION_KEY, 32 bytes base64) is split per-tenant via HKDF(schoolId),
// so one school's data can't be decrypted with another's derived key. Ciphertext
// is tagged "enc:v1:"; decrypt passes through anything else (legacy plaintext) so
// existing rows keep working. If no key is configured, encryption is disabled
// (stores plaintext) with a one-time warning — never a hard failure.
// =============================================================================

import crypto from "node:crypto";

const PREFIX = "enc:v1:";
let warned = false;

function masterKey(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console -- reason: boot-time security notice
      console.warn("[field-crypto] DATA_ENCRYPTION_KEY unset — field encryption DISABLED.");
    }
    return null;
  }
  const buf = Buffer.from(raw, "base64");
  return buf.length >= 32 ? buf.subarray(0, 32) : null;
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
