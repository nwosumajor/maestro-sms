// The signature on a local presigned URL, kept apart from both the provider that
// mints one and the controller that checks one — they would otherwise import
// each other, and a cycle that resolves at request time still breaks whenever
// module initialisation order changes.
import crypto from "node:crypto";
import { signingSecret } from "../auth/secrets";

/**
 * "get-inline" is a DIFFERENT operation from "get", not a flag on it: serving a
 * stored file as something a browser will render is a distinct permission, and
 * keeping it in the signature means it cannot be switched on by editing a URL.
 *
 * AND THE TYPE IS PART OF THE OPERATION. Inline serving used to mean one thing —
 * the school logo, always a PNG, so the controller hard-coded `image/png`. A
 * second inline case (a lesson PDF a pupil reads in the browser) makes "what is
 * it served AS" a real question, and answering it from a query parameter would
 * put an attacker-chosen Content-Type back on an inline response, which is the
 * stored-XSS this module already has a write-up for. So it is spelt into the op
 * and covered by the HMAC.
 */
export type InlineType = "image/png" | "application/pdf";
export type StorageOp = "put" | "get" | "get-inline" | "get-inline-pdf";

/** The op that serves this type inline, and the type an inline op serves. One
 *  table, so the two directions cannot disagree. */
const INLINE_OP: Record<InlineType, StorageOp> = {
  "image/png": "get-inline",
  "application/pdf": "get-inline-pdf",
};
export const inlineOp = (type: InlineType): StorageOp => INLINE_OP[type];
export const inlineTypeOf = (op: StorageOp): InlineType | null =>
  (Object.entries(INLINE_OP).find(([, o]) => o === op)?.[0] as InlineType | undefined) ?? null;

/** HMAC over the operation, the key and the expiry. All three, because a
 *  signature that covers only the key lets a read link be replayed as a write
 *  one, and one that omits the expiry never expires. */
export function signStorage(key: string, op: StorageOp, exp: number): string {
  return crypto.createHmac("sha256", signingSecret()).update(`${op}:${key}:${exp}`).digest("hex");
}

export function signStorageUrl(key: string, op: StorageOp, ttlSeconds: number): { sig: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { sig: signStorage(key, op, exp), exp };
}
