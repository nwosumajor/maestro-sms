// =============================================================================
// What a file actually IS, as opposed to what it says it is
// =============================================================================
// The content type on an upload is a claim by whoever uploaded it, and for this
// module the uploader is a member of the public: a parent with a phone, a
// candidate with a CV. The bytes go browser→bucket through a presigned URL, so
// the API never sees them on the way in — the only place it can check is when
// the upload is confirmed.
//
// This is defence in depth rather than the primary control. A mislabelled file
// is already harmless to serve, because the download path forces
// `application/octet-stream` + `Content-Disposition: attachment` (see
// safe-content-type.ts, and the stored-XSS it was written for). What this adds
// is the other half: a member of staff downloading "birth-certificate.pdf" gets
// a PDF, not an executable that a family attached in its place.
//
// Signatures only — no parsing. The question is "does this begin the way the
// format must begin", which is cheap, allocation-free and cannot itself be an
// attack surface.
// =============================================================================

import { ACCEPTED_UPLOAD_TYPES, type AcceptedUploadType } from "@sms/types";

type Signature = { type: AcceptedUploadType; bytes: readonly number[]; offset?: number };

const SIGNATURES: readonly Signature[] = [
  // "%PDF-"
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JFIF/Exif and every other JPEG start with SOI.
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // The 8-byte PNG signature, including the CR/LF pair that detects a transfer
  // which mangled line endings.
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** The type these bytes actually are, or null if they are none we accept. */
export function sniffUploadType(buffer: Buffer): AcceptedUploadType | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (buffer.length < at + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buffer[at + i] === b)) return sig.type;
  }
  return null;
}

/** Is this a type we let anyone upload at all? Checked at presign, when the
 *  claim is all we have, and again against the bytes on confirm. */
export function isAcceptedUploadType(contentType: string | null | undefined): contentType is AcceptedUploadType {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(base);
}

/** Normalise a claimed type to its bare form (`image/jpeg; charset=x` is still
 *  a JPEG, and the parameter must not defeat a set-membership test). */
export function baseContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}
