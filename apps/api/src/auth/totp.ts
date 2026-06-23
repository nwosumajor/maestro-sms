// =============================================================================
// TOTP (RFC 6238) — hand-rolled with Node crypto (no external OTP library)
// =============================================================================
// SHA-1, 30-second step, 6 digits — the de-facto standard authenticator apps
// (Google Authenticator, Authy, 1Password) expect. Secrets are base32 (RFC 4648).
// =============================================================================

import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

export function totp(secretB32: string, time = Date.now(), step = 30): string {
  return hotp(base32Decode(secretB32), Math.floor(time / 1000 / step));
}

/** Verify a 6-digit code, allowing ±`window` steps for clock skew. */
export function verifyTotp(
  secretB32: string,
  token: string,
  window = 1,
  time = Date.now(),
  step = 30,
): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(time / 1000 / step);
  const secret = base32Decode(secretB32);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === token) return true;
  }
  return false;
}

/** otpauth:// URI an authenticator app scans (or the user pastes the secret). */
export function otpauthUri(email: string, secretB32: string, issuer = "SMS"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
