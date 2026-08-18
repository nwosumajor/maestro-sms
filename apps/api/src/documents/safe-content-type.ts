/**
 * What a stored file may be served AS.
 *
 * The vault records the content type given at upload and nothing validates it,
 * so it is attacker-chosen text. Echoing it back turns a document into whatever
 * the uploader says it is — and `text/html` returned from our own origin is a
 * script running with the reader's session. The download sets
 * `Content-Disposition: attachment`, which is the correct control and was in
 * place; it stopped protecting anything the moment one proxy branch rebuilt the
 * headers without it. A control that only works while every hop preserves it is
 * not a control, so the type itself is narrowed here as well.
 *
 * The allowlist is of INERT types — things a browser cannot execute. Anything
 * else, including `text/html`, `image/svg+xml` (scriptable) and anything
 * unrecognised, is served as a byte stream. Nothing is rejected and no existing
 * document breaks: a file still downloads, it just cannot claim to be code.
 */
const INERT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
]);

export const DEFAULT_DOWNLOAD_TYPE = "application/octet-stream";

/** The Content-Type a stored file may be served with. */
export function safeDownloadType(stored?: string | null): string {
  // Parameters are dropped: `text/html; charset=utf-8` must not slip past a
  // set-membership test, and a download has no use for a charset.
  const base = (stored ?? "").split(";")[0].trim().toLowerCase();
  return INERT_TYPES.has(base) ? base : DEFAULT_DOWNLOAD_TYPE;
}

/**
 * A filename safe to put in a header.
 *
 * The title is user-supplied. Quotes were already stripped; a control character
 * matters too, because Node THROWS on an invalid header value — so a document
 * titled with a newline would have made its own download a 500 rather than a
 * download.
 */
export function safeFilename(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- reason: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .trim();
  return cleaned.slice(0, 150) || "download";
}
