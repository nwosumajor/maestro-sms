import { drawQrCode } from "../../src/certificate/qr";

describe("drawQrCode", () => {
  it("draws a non-empty matrix of filled cells for a code", () => {
    const calls: string[] = [];
    const doc = {
      save: () => {},
      restore: () => {},
      rect: () => doc,
      fill: (c: string) => {
        calls.push(c);
        return doc;
      },
    } as unknown as PDFKit.PDFDocument;
    drawQrCode(doc, "SMS-A3F2C1D90B4E", 0, 0, 60);
    // one white quiet-zone fill + many black cell fills
    expect(calls.filter((c) => c === "#ffffff").length).toBe(1);
    expect(calls.filter((c) => c === "#000000").length).toBeGreaterThan(50);
  });
});
