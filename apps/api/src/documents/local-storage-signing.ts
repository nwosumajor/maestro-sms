// The signature on a local presigned URL, kept apart from both the provider that
// mints one and the controller that checks one — they would otherwise import
// each other, and a cycle that resolves at request time still breaks whenever
// module initialisation order changes.
import crypto from "node:crypto";
import { signingSecret } from "../auth/secrets";

/** "get-inline" is a DIFFERENT operation from "get", not a flag on it: serving a
 *  stored file as something a browser will render is a distinct permission, and
 *  keeping it in the signature means it cannot be switched on by editing a URL. */
export type StorageOp = "put" | "get" | "get-inline";

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
