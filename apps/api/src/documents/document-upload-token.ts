// =============================================================================
// The link a family gets to send their child's documents in
// =============================================================================
// A parent has no account. They are given a URL, and that URL is the whole
// credential — so what it can do has to be narrow enough that losing it is
// survivable. Forwarded to a WhatsApp group, left in a shared inbox, read off a
// screen: assume all of those.
//
// WHAT THE TOKEN CAN DO: see which documents are still wanted for ONE
// application, and send files in against them.
//
// WHAT IT CANNOT DO, deliberately:
//   - read back anything already uploaded. This is the important one. A birth
//     certificate that a leaked link can be pointed at is a birth certificate
//     published. The family sees that a file arrived and what the school made of
//     it; the BYTES are only ever served to staff, over an authenticated,
//     audited route.
//   - reach a different application. The subject comes from the signed token and
//     from nowhere else — never from a body or a query, which is the same rule
//     the platform applies to school_id (Golden Rule #3).
//   - decide anything. No verifying, no waiving, no editing what the school asks
//     for.
//
// Signed HS256 with the same AUTH_SECRET as every other token family, and scoped
// by `purpose` so a session bearer can never be replayed here and this can never
// be replayed as a session. The same shape as invite.ts, for the same reason:
// one secret, one trust root, and the purpose is what keeps the families apart.
// =============================================================================

import jwt from "jsonwebtoken";
import { UPLOAD_TOKEN_TTL_DAYS } from "@sms/types";
import { signingSecret, verifyHs256 } from "../auth/secrets";

const UPLOAD_PURPOSE = "docupload";

export type UploadTokenSubject = {
  /** The application these documents belong to. */
  applicationId: string;
  schoolId: string;
};

export function mintDocumentUploadToken(applicationId: string, schoolId: string): string {
  return jwt.sign({ sub: applicationId, school_id: schoolId, purpose: UPLOAD_PURPOSE }, signingSecret(), {
    algorithm: "HS256",
    expiresIn: `${UPLOAD_TOKEN_TTL_DAYS}d`,
  });
}

/**
 * The application this token speaks for, or null for ANY invalid, expired or
 * wrong-purpose token.
 *
 * One null for every failure, and callers answer with one generic message: which
 * check failed is information, and the person asking is unauthenticated.
 */
export function verifyDocumentUploadToken(token: string | undefined): UploadTokenSubject | null {
  if (!token) return null;
  try {
    const payload = verifyHs256(token);
    if (payload.purpose !== UPLOAD_PURPOSE) return null;
    const applicationId = payload.sub as string | undefined;
    const schoolId = payload.school_id as string | undefined;
    if (!applicationId || !schoolId) return null;
    return { applicationId, schoolId };
  } catch {
    return null;
  }
}
