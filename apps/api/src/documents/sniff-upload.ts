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

import { ACCEPTED_UPLOAD_TYPES, RECORDING_UPLOAD_TYPES, type AcceptedUploadType, type RecordingUploadType, type SniffableUploadType } from "@sms/types";

type Signature = { type: SniffableUploadType; bytes: readonly number[]; offset?: number };

/**
 * MP4 is the one format here whose signature is not enough on its own.
 *
 * `ftyp` at offset 4 is ISO base media — which is ALSO QuickTime `.mov`, and a
 * `.mov` served as `video/mp4` is a video that silently does not play for the
 * pupil it was recorded for. The four bytes AFTER it are the major brand, so the
 * check is "is this ISO BMFF, and is it an MP4 brand". `qt  ` is the brand that
 * makes this worth doing: it is the one a Mac screen recording writes.
 */
const MP4_BRANDS: readonly string[] = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "mmp4", "M4V "];
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

function isMp4(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (!FTYP.every((b, i) => buffer[4 + i] === b)) return false;
  return MP4_BRANDS.includes(buffer.subarray(8, 12).toString("latin1"));
}

const SIGNATURES: readonly Signature[] = [
  // "%PDF-"
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JFIF/Exif and every other JPEG start with SOI.
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // The 8-byte PNG signature, including the CR/LF pair that detects a transfer
  // which mangled line endings.
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/**
 * The type these bytes actually are, or null if they are none we can name.
 *
 * NAMING is not ACCEPTING. This knows every type any feature takes; each caller
 * then checks the answer against its OWN allowlist, so a video recognised here
 * is still refused where a birth certificate belongs.
 */
export function sniffUploadType(buffer: Buffer): SniffableUploadType | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (buffer.length < at + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buffer[at + i] === b)) return sig.type;
  }
  return isMp4(buffer) ? "video/mp4" : null;
}

/** Is this a type we let a member of the PUBLIC attach to an application or an
 *  admission? Checked at presign, when the claim is all we have, and again
 *  against the bytes on confirm. */
export function isAcceptedUploadType(contentType: string | null | undefined): contentType is AcceptedUploadType {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(base);
}

/** Is this a type a teacher may upload as a recording of their own class? A
 *  SEPARATE allowlist, so neither feature widens the other. */
export function isRecordingUploadType(contentType: string | null | undefined): contentType is RecordingUploadType {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return (RECORDING_UPLOAD_TYPES as readonly string[]).includes(base);
}

/** Normalise a claimed type to its bare form (`image/jpeg; charset=x` is still
 *  a JPEG, and the parameter must not defeat a set-membership test). */
export function baseContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}
