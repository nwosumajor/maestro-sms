// =============================================================================
// QR code rendering for ID cards
// =============================================================================
// Encodes the member's global `uniqueId` (opaque, non-PII) as a REAL scannable
// QR — replacing the old decorative "barcode strip". Drawn as vector squares so
// it stays consistent with the module's no-external-image approach and prints
// crisply at any size. A scanner reads the uniqueId; the tenant-scoped
// /members/scan lookup resolves it to a member of the SCANNER's own school.
// =============================================================================
import QRCode from "qrcode";

/**
 * Draw a QR encoding `text` into `doc`, top-left at (x, y), fitting `size` pt.
 * Includes a white quiet zone (required for reliable scanning) and error
 * correction level M (~15% damage tolerance — fine for a laminated card).
 */
export function drawQrCode(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  size: number,
): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cells = qr.modules.data;
  const cell = size / n;

  doc.save();
  // Quiet zone: a white margin one cell wide on every side, or scanners fail.
  doc.rect(x - cell, y - cell, size + cell * 2, size + cell * 2).fill("#ffffff");
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (cells[row * n + col]) {
        // +0.2 overlap closes hairline gaps between cells at print resolution.
        doc.rect(x + col * cell, y + row * cell, cell + 0.2, cell + 0.2).fill("#000000");
      }
    }
  }
  doc.restore();
}
