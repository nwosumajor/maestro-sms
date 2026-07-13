// Byte-level image dimension extraction for logo upload validation.
// SECURITY: the uploaded bytes are untrusted — we parse ONLY the fixed-position
// PNG IHDR / JPEG SOF headers (bounds-checked reads, no decode, no external
// image library) to enforce the shape/size contract before the bytes are stored.

/** Width/height of a PNG or JPEG buffer, or null when the bytes aren't a valid
 *  image of the declared type (mismatched magic bytes, truncated header). */
export function readImageDimensions(
  buffer: Buffer,
  contentType: "image/png" | "image/jpeg",
): { width: number; height: number } | null {
  return contentType === "image/png" ? readPng(buffer) : readJpeg(buffer);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buffer: Buffer): { width: number; height: number } | null {
  // Signature (8) + IHDR length/type (8) + width (4) + height (4) = 24 bytes min.
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpeg(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  // Walk the marker segments until a Start-Of-Frame carrying the dimensions.
  let offset = 2;
  while (offset + 9 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC) hold height/width.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    // Standalone markers (D0–D9) have no length field.
    if (marker >= 0xd0 && marker <= 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}
