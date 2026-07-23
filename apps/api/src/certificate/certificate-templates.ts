// =============================================================================
// Certificate / ID-card PDF templates (pure)
// =============================================================================
// Professional, self-contained pdfkit renderers — every ornament (engraved
// multi-rule border, corner flourishes, watermark monogram, scalloped official
// seal, signature blocks, barcode strip) is DRAWN with vector primitives, so no
// external assets are needed and a missing school logo degrades to a drawn
// monogram medallion. Pure functions of (data, logo bytes) -> Buffer: no DB, no
// randomness beyond pdfkit's internals — exhaustively unit-testable.
//
// The accent colour derives from the school's branding theme (HSL row) so every
// document is on-brand per tenant; gold is a fixed complementary metallic.
// =============================================================================

import PDFDocument from "pdfkit";
import { drawQrCode } from "./qr";

type Doc = InstanceType<typeof PDFDocument>;

export interface CertificateData {
  type: string; // COMPLETION | PARTICIPATION | MERIT
  title?: string | null;
  body?: string | null;
  subjectName: string;
  schoolName: string;
  schoolAddress?: string | null;
  serial: string;
  issuedByName: string;
  principalName?: string | null;
  issuedOn: Date;
  /** Hex accent from the school's branding theme (falls back to platform navy). */
  accent?: string | null;
}

export interface IdCardData {
  subjectName: string;
  uniqueId: string;
  roleLabel: string;
  schoolName: string;
  schoolAddress?: string | null;
  serial: string;
  issuedOn: Date;
  accent?: string | null;
}

const NAVY = "#1e3a5f";
const GOLD = "#b08d2e";
const GOLD_LIGHT = "#d9c68a";
const INK = "#1c1c1c";
const MUTED = "#5b6470";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** Deterministic long-form date (no locale dependence — matches the pinned-
 *  formatter rule from the hydration hardening). */
export function formatLongDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** School branding is stored as HSL ints; pdfkit wants hex. Pure + tested. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/** Darken a hex colour by a factor (0..1) — used for gradients/name emphasis. */
function darken(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) =>
    Math.max(0, Math.round(((n >> shift) & 0xff) * (1 - factor)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Best-effort logo draw — a corrupt/unsupported image must never break the PDF. */
function drawLogo(doc: Doc, logo: Buffer | null | undefined, x: number, y: number, size: number): boolean {
  if (!logo) return false;
  try {
    doc.image(logo, x, y, { fit: [size, size], align: "center", valign: "center" });
    return true;
  } catch {
    return false;
  }
}

/** Drawn monogram medallion — the logo fallback so headers never look empty. */
function drawMedallion(doc: Doc, cx: number, cy: number, r: number, accent: string, initials: string): void {
  doc.save();
  doc.circle(cx, cy, r).lineWidth(2).stroke(accent);
  doc.circle(cx, cy, r - 4).lineWidth(0.8).stroke(GOLD);
  doc
    .font("Times-Bold")
    .fontSize(r * 0.85)
    .fillColor(accent)
    .text(initials || "S", cx - r, cy - r * 0.5, { width: r * 2, align: "center" });
  doc.restore();
}

/** Scalloped double-ring official seal with ribbon tails. */
function drawSeal(doc: Doc, cx: number, cy: number, r: number, accent: string, initials: string, year: number): void {
  doc.save();
  // Ribbon tails first so the disc overlaps them.
  doc
    .polygon([cx - 8, cy + r - 6], [cx - 22, cy + r + 20], [cx - 12, cy + r + 15], [cx - 4, cy + r + 24])
    .fill(darken(accent, 0.15));
  doc
    .polygon([cx + 8, cy + r - 6], [cx + 22, cy + r + 20], [cx + 12, cy + r + 15], [cx + 4, cy + r + 24])
    .fill(accent);
  // Scalloped edge: a ring of small studs.
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    doc.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6).fill(GOLD);
  }
  doc.circle(cx, cy, r).lineWidth(1.6).fillAndStroke("#fdfaf1", GOLD);
  doc.circle(cx, cy, r - 7).lineWidth(0.9).stroke(accent);
  doc
    .font("Helvetica-Bold")
    .fontSize(5.6)
    .fillColor(MUTED)
    .text("OFFICIAL SEAL", cx - r, cy - 16, { width: r * 2, align: "center", characterSpacing: 1.2 });
  doc
    .font("Times-Bold")
    .fontSize(17)
    .fillColor(accent)
    .text(initials || "S", cx - r, cy - 8, { width: r * 2, align: "center" });
  doc
    .font("Helvetica")
    .fontSize(6)
    .fillColor(MUTED)
    .text(String(year), cx - r, cy + 12, { width: r * 2, align: "center", characterSpacing: 2 });
  doc.restore();
}

/** Engraved-style page frame: layered rules + corner diamonds/flourishes. */
function drawFrame(doc: Doc, accent: string): void {
  const w = doc.page.width;
  const h = doc.page.height;
  doc.save();
  // Parchment wash inside the frame.
  doc.rect(20, 20, w - 40, h - 40).fill("#fdfcf7");
  doc.lineWidth(3).strokeColor(accent).rect(20, 20, w - 40, h - 40).stroke();
  doc.lineWidth(1.2).strokeColor(GOLD).rect(30, 30, w - 60, h - 60).stroke();
  doc.lineWidth(0.5).strokeColor(GOLD_LIGHT).rect(36, 36, w - 72, h - 72).stroke();
  // Corner ornaments: diamond + 45° flourish pair at each inner-frame corner.
  const corners: Array<[number, number, number, number]> = [
    [30, 30, 1, 1],
    [w - 30, 30, -1, 1],
    [30, h - 30, 1, -1],
    [w - 30, h - 30, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    doc
      .polygon([x, y - 7], [x + 7, y], [x, y + 7], [x - 7, y])
      .fill(accent);
    doc
      .lineWidth(1)
      .strokeColor(GOLD)
      .moveTo(x + 12 * dx, y + 4 * dy)
      .lineTo(x + 34 * dx, y + 4 * dy)
      .stroke()
      .moveTo(x + 4 * dx, y + 12 * dy)
      .lineTo(x + 4 * dx, y + 34 * dy)
      .stroke();
  }
  doc.restore();
}

/** Centre-diamond divider rule. */
function drawDivider(doc: Doc, cx: number, y: number, width: number, accent: string): void {
  doc.save();
  doc.lineWidth(0.8).strokeColor(GOLD);
  doc.moveTo(cx - width / 2, y).lineTo(cx - 8, y).stroke();
  doc.moveTo(cx + 8, y).lineTo(cx + width / 2, y).stroke();
  doc.polygon([cx, y - 4], [cx + 4, y], [cx, y + 4], [cx - 4, y]).fill(accent);
  doc.restore();
}

const CERT_TITLES: Record<string, string> = {
  COMPLETION: "Certificate of Completion",
  PARTICIPATION: "Certificate of Participation",
  MERIT: "Certificate of Merit",
};
// Citation defaults — each reads as a continuation of “presented to <name> …”.
const CERT_BODIES: Record<string, string> = {
  COMPLETION:
    "who has successfully completed the prescribed course of study, fulfilled every academic requirement set forth by the school, and is hereby awarded this certificate in recognition of that achievement.",
  PARTICIPATION:
    "who took part with enthusiasm and made a commendable contribution, and is hereby presented with this certificate in warm appreciation of their involvement.",
  MERIT:
    "who has demonstrated outstanding merit, exemplary conduct and distinguished performance, and is hereby awarded this certificate with the highest commendation of the school.",
};

export function renderCertificate(d: CertificateData, logo?: Buffer | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const accent = d.accent || NAVY;
    const w = doc.page.width;
    const h = doc.page.height;
    const cx = w / 2;
    const schoolInitials = initialsOf(d.schoolName);

    drawFrame(doc, accent);

    // Watermark monogram behind the content.
    doc.save();
    doc.fillOpacity(0.04);
    doc
      .font("Times-Bold")
      .fontSize(300)
      .fillColor(accent)
      .text(schoolInitials || "S", 0, h / 2 - 190, { width: w, align: "center" });
    doc.restore();

    // Header: logo (or medallion) + school identity.
    const logoSize = 62;
    if (!drawLogo(doc, logo, cx - logoSize / 2, 64, logoSize)) {
      drawMedallion(doc, cx, 64 + logoSize / 2, logoSize / 2, accent, schoolInitials);
    }
    doc
      .font("Times-Bold")
      .fontSize(27)
      .fillColor(accent)
      .text(d.schoolName, 60, 140, { width: w - 120, align: "center" });
    if (d.schoolAddress) {
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(d.schoolAddress, 60, doc.y + 2, { width: w - 120, align: "center" });
    }
    drawDivider(doc, cx, doc.y + 10, 320, accent);

    // Title + presentation line.
    const title = d.title || CERT_TITLES[d.type] || "Certificate of Achievement";
    doc
      .font("Times-Bold")
      .fontSize(24)
      .fillColor(INK)
      .text(title.toUpperCase(), 60, doc.y + 20, { width: w - 120, align: "center", characterSpacing: 3 });
    doc
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor(MUTED)
      .text("This certificate is proudly presented to", 60, doc.y + 14, {
        width: w - 120,
        align: "center",
        characterSpacing: 0.5,
      });

    // Recipient name with a flourished underline.
    doc
      .font("Times-BoldItalic")
      .fontSize(34)
      .fillColor(darken(accent, 0.25))
      .text(d.subjectName, 60, doc.y + 8, { width: w - 120, align: "center" });
    const nameWidth = Math.min(430, doc.widthOfString(d.subjectName) + 90);
    const underlineY = doc.y + 6;
    doc.lineWidth(1).strokeColor(GOLD);
    doc.moveTo(cx - nameWidth / 2, underlineY).lineTo(cx + nameWidth / 2, underlineY).stroke();
    doc.polygon([cx - nameWidth / 2 - 6, underlineY], [cx - nameWidth / 2, underlineY - 3], [cx - nameWidth / 2, underlineY + 3]).fill(GOLD);
    doc.polygon([cx + nameWidth / 2 + 6, underlineY], [cx + nameWidth / 2, underlineY - 3], [cx + nameWidth / 2, underlineY + 3]).fill(GOLD);

    // Citation body.
    const body = d.body || CERT_BODIES[d.type] || CERT_BODIES.COMPLETION;
    doc
      .font("Times-Roman")
      .fontSize(12)
      .fillColor("#3c4250")
      .text(body, cx - 270, underlineY + 16, { width: 540, align: "center", lineGap: 2.5 });

    // Footer: signatures flanking the official seal.
    const sigY = h - 108;
    const sigW = 170;
    const sig = (centerX: number, name: string, role: string) => {
      doc.lineWidth(0.9).strokeColor("#8a8f98");
      doc.moveTo(centerX - sigW / 2, sigY).lineTo(centerX + sigW / 2, sigY).stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(INK)
        .text(name, centerX - sigW / 2, sigY + 5, { width: sigW, align: "center" });
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(role.toUpperCase(), centerX - sigW / 2, sigY + 18, { width: sigW, align: "center", characterSpacing: 1.5 });
    };
    sig(cx - 250, d.issuedByName, "Issuing Officer");
    sig(cx + 250, d.principalName || "", "Principal / Head of School");
    drawSeal(doc, cx, sigY - 12, 36, accent, schoolInitials, d.issuedOn.getFullYear());

    // Provenance strip.
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#9096a0")
      .text(
        `Serial ${d.serial}   ·   Issued ${formatLongDate(d.issuedOn)}   ·   Authenticity may be verified with the issuing school by quoting the serial number.`,
        60,
        h - 52,
        { width: w - 120, align: "center" },
      );

    doc.end();
  });
}

export function renderIdCard(d: IdCardData, logo?: Buffer | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const W = 340;
    const H = 215;
    const doc = new PDFDocument({ size: [W, H], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const accent = d.accent || NAVY;
    const accentDark = darken(accent, 0.35);
    const initials = initialsOf(d.schoolName);

    // ---- FRONT ----
    // Accent spine + gradient header band.
    doc.rect(0, 0, 8, H).fill(accentDark);
    const grad = doc.linearGradient(8, 0, W, 0);
    grad.stop(0, accent).stop(1, accentDark);
    doc.rect(8, 0, W - 8, 56).fill(grad);
    // Logo plate (uploaded logo or monogram).
    doc.roundedRect(18, 10, 36, 36, 6).fill("#ffffff");
    if (!drawLogo(doc, logo, 21, 13, 30)) {
      doc
        .font("Times-Bold")
        .fontSize(16)
        .fillColor(accent)
        .text(initials || "S", 18, 20, { width: 36, align: "center" });
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(12.5)
      .fillColor("#ffffff")
      .text(d.schoolName, 62, 12, { width: W - 74, lineBreak: false, ellipsis: true });
    if (d.schoolAddress) {
      doc
        .font("Helvetica")
        .fontSize(6.3)
        .fillColor("#dbe4ee")
        .text(d.schoolAddress, 62, 28, { width: W - 74, lineBreak: false, ellipsis: true });
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor("#ffffff")
      .text(`${d.roleLabel.toUpperCase()} IDENTITY CARD`, 62, 42, { characterSpacing: 1.6 });

    // Photo placeholder with a drawn silhouette.
    doc.roundedRect(18, 66, 72, 92, 6).fillAndStroke("#eef2f7", "#c8d2de");
    doc.save();
    doc.roundedRect(18, 66, 72, 92, 6).clip();
    doc.circle(54, 104, 14).fill("#a5b2c2");
    doc.roundedRect(32, 122, 44, 46, 16).fill("#a5b2c2");
    doc.restore();
    doc
      .font("Helvetica")
      .fontSize(5.5)
      .fillColor("#8b97a6")
      .text("AFFIX PHOTO", 18, 72, { width: 72, align: "center", characterSpacing: 1 });

    // Identity block.
    const bx = 102;
    doc.font("Helvetica-Bold").fontSize(14).fillColor(INK).text(d.subjectName, bx, 70, { width: W - bx - 14 });
    // Role chip.
    const chipW = doc.widthOfString(d.roleLabel.toUpperCase()) * (7.5 / 14) + 18;
    const chipY = doc.y + 4;
    doc.save();
    doc.fillOpacity(0.12);
    doc.roundedRect(bx, chipY, Math.max(chipW, 52), 13, 6.5).fill(accent);
    doc.restore();
    doc
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .fillColor(accentDark)
      .text(d.roleLabel.toUpperCase(), bx + 9, chipY + 3.5, { characterSpacing: 1 });

    doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("UNIQUE ID", bx, chipY + 22, { characterSpacing: 1.2 });
    doc.font("Courier-Bold").fontSize(12.5).fillColor(INK).text(d.uniqueId, bx, chipY + 30);
    doc
      .font("Helvetica")
      .fontSize(6.5)
      .fillColor(MUTED)
      .text(`Issued ${formatLongDate(d.issuedOn)}`, bx, chipY + 46);

    // REAL scannable QR encoding the member's global uniqueId (opaque, non-PII).
    // A library / attendance / gate scanner reads it, and the tenant-scoped
    // /members/scan lookup resolves it to a member of the scanner's own school.
    const qrSize = 58;
    const qrX = W - qrSize - 16;
    const qrY = 138;
    drawQrCode(doc, d.uniqueId, qrX, qrY, qrSize);
    doc
      .font("Helvetica")
      .fontSize(5)
      .fillColor(MUTED)
      .text("SCAN TO VERIFY", qrX - 2, qrY + qrSize + 3, { width: qrSize + 8, align: "center", characterSpacing: 0.5 });
    doc.font("Courier").fontSize(5.5).fillColor(MUTED).text(d.serial, bx, 196);
    doc
      .font("Helvetica")
      .fontSize(5.5)
      .fillColor("#9aa3af")
      .text(`Property of ${d.schoolName}.`, 18, H - 13, { width: W - 36, lineBreak: false, ellipsis: true });

    // ---- BACK ----
    doc.addPage({ size: [W, H], margin: 0 });
    doc.rect(0, 0, W, H).fill("#fbfcfe");
    doc.rect(0, 0, W, 10).fill(accent);
    doc.rect(0, H - 10, W, 10).fill(accentDark);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(accentDark)
      .text("CONDITIONS OF USE", 20, 24, { characterSpacing: 1.5 });
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#454c58")
      .text(
        `This card identifies a member of ${d.schoolName} and remains the property of the school. ` +
          `It must be carried on the premises and produced on request. It is not transferable. ` +
          `Loss or damage must be reported to the school office immediately.`,
        20,
        38,
        { width: W - 40, lineGap: 2 },
      );
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor("#454c58")
      .text(
        `If found, please return to: ${d.schoolName}${d.schoolAddress ? `, ${d.schoolAddress}` : ""}.`,
        20,
        doc.y + 8,
        { width: W - 40, lineGap: 2 },
      );
    doc.lineWidth(0.8).strokeColor("#8a8f98").moveTo(20, 168).lineTo(150, 168).stroke();
    doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("HOLDER'S SIGNATURE", 20, 172, { characterSpacing: 1 });
    doc.font("Courier").fontSize(6).fillColor(MUTED).text(`Serial ${d.serial}`, 20, H - 26);
    doc.end();
  });
}
