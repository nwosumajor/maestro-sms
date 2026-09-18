// The signature on a local presigned URL, kept apart from both the provider that
// mints one and the controller that checks one — they would otherwise import
// each other, and a cycle that resolves at request time still breaks whenever
// module initialisation order changes.
import crypto from "node:crypto";
import { signingSecret } from "../auth/secrets";
// Read straight from the shared constants rather than through sniff-upload:
// this module is deliberately import-light so the provider that MINTS a
// signature and the controller that CHECKS one can both depend on it without
// a cycle.
import { MAX_RECORDING_BYTES, MAX_UPLOAD_BYTES, RECORDING_UPLOAD_TYPES } from "@sms/types";

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
export type InlineType = "image/png" | "application/pdf" | "video/mp4";
export type StorageOp = "put" | "put-recording" | "get" | "get-inline" | "get-inline-pdf" | "get-inline-video";

/** The op that serves this type inline, and the type an inline op serves. One
 *  table, so the two directions cannot disagree. */
const INLINE_OP: Record<InlineType, StorageOp> = {
  "image/png": "get-inline",
  "application/pdf": "get-inline-pdf",
  // A class recording. There is NO "get" (attachment) op minted for one
  // anywhere — that is what "plays but is not offered for download" means here,
  // and it is a property of which operation is ever SIGNED, not of the markup.
  "video/mp4": "get-inline-video",
};

/** Every inline op there is, derived from the one table. The download route
 *  used to try each by name in a hand-written `??` chain, which is a list that
 *  goes stale the moment a type is added — exactly how the second inline type
 *  would have been served as a byte stream. */
export const INLINE_OPS: readonly StorageOp[] = Object.values(INLINE_OP);
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

/**
 * AND THE CEILING IS PART OF THE OPERATION, for the same reason the inline type
 * is.
 *
 * There are two ceilings in this platform — a 10 MB document and a 1.5 GB
 * lesson recording — and the local storage door enforced only the first, on
 * every upload. So a recording was refused at 10 MB by the one hop between a
 * presign that had allowed it and a confirm that would have accepted it: the
 * feature could not be exercised locally at all, which is how a defect reaches
 * production unseen. Sibling asymmetry, on a rule somebody had already written
 * down twice.
 *
 * Deriving the limit from the SIGNED op is what stops that recurring. A caller
 * cannot raise its own ceiling by sending a bigger file or editing a URL — the
 * op is inside the HMAC — and a third ceiling is a row here rather than a
 * fourth place to remember.
 */
const UPLOAD_LIMIT: Record<UploadOp, number> = {
  put: MAX_UPLOAD_BYTES,
  "put-recording": MAX_RECORDING_BYTES,
};

export type UploadOp = "put" | "put-recording";

/** Every op that WRITES, derived from the one table. */
export const UPLOAD_OPS: readonly UploadOp[] = Object.keys(UPLOAD_LIMIT) as UploadOp[];

/** Which write op a presign should mint, from the type being uploaded. */
export const uploadOp = (contentType: string): UploadOp =>
  (RECORDING_UPLOAD_TYPES as readonly string[]).includes(contentType) ? "put-recording" : "put";

/** The ceiling this signed op grants, and nothing wider. */
export const uploadLimitOf = (op: UploadOp): number => UPLOAD_LIMIT[op];
