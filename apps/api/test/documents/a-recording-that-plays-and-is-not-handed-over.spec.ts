// =============================================================================
// A recording plays, and is never handed over
// =============================================================================
// A recorded lesson is footage of named children, so "students can watch it but
// not download it" is the requirement it was built for. That promise cannot be
// kept by the markup — anything a browser plays can be captured — and this
// codebase already takes that position on client-side controls: they are
// friction, never enforcement.
//
// What CAN be enforced is which operation is ever SIGNED. `inline` is the TYPE
// the server vouches for, and each type has its own signed op; a recording gets
// `get-inline-video` and nothing mints the attachment op for one. So a URL
// cannot be edited into a download, because the download was never granted —
// the same property the lesson PDF relies on, extended rather than re-invented.
//
// The other half is that it must actually PLAY: a video served without ranges
// cannot seek, and Safari refuses to start at all.
// =============================================================================

import { ACCEPTED_UPLOAD_TYPES, RECORDING_UPLOAD_TYPES, SNIFFABLE_UPLOAD_TYPES } from "@sms/types";
import { inlineOp, inlineTypeOf, INLINE_OPS } from "../../src/documents/local-storage-signing";
import { isAcceptedUploadType, isRecordingUploadType, sniffUploadType } from "../../src/documents/sniff-upload";
import { safeDownloadType } from "../../src/documents/safe-content-type";

/** An MP4 header: 4 bytes of box size, "ftyp", then the major brand. */
const mp4 = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp"), Buffer.from(brand, "latin1"), Buffer.alloc(16)]);

describe("naming a file is not accepting one", () => {
  it("recognises an MP4", () => {
    expect(sniffUploadType(mp4("isom"))).toBe("video/mp4");
    expect(sniffUploadType(mp4("mp42"))).toBe("video/mp4");
  });

  it("refuses a QuickTime .mov wearing an ISO container", () => {
    // `ftyp` alone is ISO base media, which a Mac screen recording also writes.
    // Accepting it would store a file that simply does not play for the pupil
    // it was recorded for, with nothing on screen saying why.
    expect(sniffUploadType(mp4("qt  "))).toBeNull();
  });

  it("does NOT let a video into the family-document allowlist", () => {
    // That list is what a parent may attach where a birth certificate belongs.
    // The whole reason the two lists are separate.
    expect(isAcceptedUploadType("video/mp4")).toBe(false);
    expect(ACCEPTED_UPLOAD_TYPES).not.toContain("video/mp4");
  });

  it("does NOT let a PDF in as a recording", () => {
    expect(isRecordingUploadType("application/pdf")).toBe(false);
    expect(isRecordingUploadType("video/mp4")).toBe(true);
  });

  it("can name every type some feature accepts, and no more", () => {
    // A sniffer that cannot name a type a feature accepts refuses every honest
    // upload of it; one that names types nothing accepts is dead vocabulary.
    expect([...SNIFFABLE_UPLOAD_TYPES].sort()).toEqual(
      [...new Set([...ACCEPTED_UPLOAD_TYPES, ...RECORDING_UPLOAD_TYPES])].sort(),
    );
  });
});

describe("which operation is signed", () => {
  it("a recording has its OWN inline op, distinct from every other", () => {
    expect(inlineOp("video/mp4")).toBe("get-inline-video");
    expect(inlineOp("video/mp4")).not.toBe(inlineOp("application/pdf"));
    expect(inlineOp("video/mp4")).not.toBe(inlineOp("image/png"));
  });

  it("round-trips: the op names the type it serves", () => {
    // The type comes from the OP, which is inside the HMAC — never from a query
    // parameter an attacker chooses.
    expect(inlineTypeOf("get-inline-video")).toBe("video/mp4");
  });

  it("the download route's op list is DERIVED, so a new type cannot be missed", () => {
    // It was a hand-written `??` chain. A third inline type would have been
    // signed correctly, refused as inline, and served as a byte stream — a
    // download, which is the one outcome this feature exists to prevent.
    expect(INLINE_OPS).toContain("get-inline-video");
    expect(INLINE_OPS).toHaveLength(3);
    expect(INLINE_OPS).not.toContain("get");
  });

  it("serves the video as itself, not as a byte stream", () => {
    // `safeDownloadType` degrades anything it does not know to
    // application/octet-stream, which a browser downloads instead of playing.
    expect(safeDownloadType("video/mp4")).toBe("video/mp4");
  });

  it("still degrades an UNKNOWN type, so the allowlist is doing the work", () => {
    expect(safeDownloadType("video/x-msvideo")).toBe("application/octet-stream");
    expect(safeDownloadType("text/html")).toBe("application/octet-stream");
  });
});
