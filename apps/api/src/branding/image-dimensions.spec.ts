import { isValidLogoDimensions, LOGO_MAX_SIDE_PX, LOGO_MIN_SIDE_PX } from "@sms/types";
import { readImageDimensions } from "./image-dimensions";

/** Minimal valid PNG header: signature + IHDR chunk with the given dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR length
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** Minimal JPEG: SOI + APP0 filler segment + SOF0 with the given dimensions. */
function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(2 + 16);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  const sof0 = Buffer.alloc(2 + 17);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

describe("readImageDimensions", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(readImageDimensions(pngBytes(512, 512), "image/png")).toEqual({ width: 512, height: 512 });
    expect(readImageDimensions(pngBytes(300, 200), "image/png")).toEqual({ width: 300, height: 200 });
  });

  it("reads JPEG SOF dimensions past earlier segments", () => {
    expect(readImageDimensions(jpegBytes(640, 640), "image/jpeg")).toEqual({ width: 640, height: 640 });
    expect(readImageDimensions(jpegBytes(1024, 768), "image/jpeg")).toEqual({ width: 1024, height: 768 });
  });

  it("rejects bytes whose magic does not match the declared type", () => {
    expect(readImageDimensions(pngBytes(512, 512), "image/jpeg")).toBeNull();
    expect(readImageDimensions(jpegBytes(512, 512), "image/png")).toBeNull();
    expect(readImageDimensions(Buffer.from("<svg onload=alert(1)></svg>"), "image/png")).toBeNull();
    expect(readImageDimensions(Buffer.from("plain text"), "image/jpeg")).toBeNull();
  });

  it("rejects truncated headers", () => {
    expect(readImageDimensions(pngBytes(512, 512).subarray(0, 12), "image/png")).toBeNull();
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0), "image/png")).toBeNull();
  });
});

describe("isValidLogoDimensions", () => {
  it("accepts squares within the pixel bounds", () => {
    expect(isValidLogoDimensions(LOGO_MIN_SIDE_PX, LOGO_MIN_SIDE_PX)).toBe(true);
    expect(isValidLogoDimensions(512, 512)).toBe(true);
    expect(isValidLogoDimensions(LOGO_MAX_SIDE_PX, LOGO_MAX_SIDE_PX)).toBe(true);
  });

  it("accepts near-square within the 10% tolerance, rejects beyond it", () => {
    expect(isValidLogoDimensions(550, 500)).toBe(true); // 1.10 — at the edge
    expect(isValidLogoDimensions(560, 500)).toBe(false); // 1.12 — beyond
    expect(isValidLogoDimensions(500, 560)).toBe(false);
  });

  it("rejects out-of-bounds or degenerate sizes", () => {
    expect(isValidLogoDimensions(LOGO_MIN_SIDE_PX - 1, LOGO_MIN_SIDE_PX - 1)).toBe(false);
    expect(isValidLogoDimensions(LOGO_MAX_SIDE_PX + 1, LOGO_MAX_SIDE_PX + 1)).toBe(false);
    expect(isValidLogoDimensions(0, 0)).toBe(false);
    expect(isValidLogoDimensions(-512, 512)).toBe(false);
    expect(isValidLogoDimensions(Number.NaN, 512)).toBe(false);
  });
});
