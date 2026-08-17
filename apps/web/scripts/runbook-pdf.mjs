// =============================================================================
// The PDF emitter — blocks in, bytes out
// =============================================================================
// A real file, generated with pdfkit from the SAME parse as the HTML page, so a
// runbook cannot say one thing on screen and another in the document somebody
// emailed. It is built at build time rather than on request: the markdown lives
// in docs/, which is not in the API container, and a PDF that only exists where
// the repository is checked out is the wrong shape for something read on call.
//
// Deliberately plain. This is an operations document, not a brochure: what it
// owes the reader is that a command is copyable, a table is readable, and a
// section can be found. Everything below serves one of those three.
// =============================================================================

import PDFDocument from "pdfkit";
import { inlineRuns } from "./markdown-blocks.mjs";

const PAGE = { margin: 54, size: "A4" };
const INK = "#111111";
const MUTED = "#555555";
const RULE = "#d4d4d8";
const CODE_BG = "#f4f4f5";

const SIZE = { h1: 20, h2: 14, h3: 11.5, body: 9.5, code: 8, small: 7.5 };

/**
 * Characters pdfkit's built-in fonts cannot encode, and what to print instead.
 *
 * The standard PDF fonts are WinAnsi; anything outside it comes out as garbage
 * rather than as nothing, so it is not a cosmetic issue — an arrow in
 * "CloudFront -> ALB" turning into `!'` makes an architecture note unreadable,
 * and a mangled naira sign misstates money. Found by encoding both runbooks and
 * listing what failed, rather than by guessing which symbols were used.
 *
 * Transliteration rather than an embedded Unicode font: five characters do not
 * justify shipping a font file, and the ASCII forms are the ones these documents
 * already use elsewhere.
 */
const TRANSLITERATE = [
  [/\u2192/g, "->"],
  [/\u2190/g, "<-"],
  [/\u2191/g, "^"],
  [/\u2193/g, "v"],
  [/\u2265/g, ">="],
  [/\u2264/g, "<="],
  [/\u20a6/g, "NGN "],
];

const winAnsi = (s) => TRANSLITERATE.reduce((acc, [re, to]) => acc.replace(re, to), s);

/**
 * @param {{title:string, subtitle:string, source:string, blocks:import("./markdown-blocks.mjs").Block[]}} doc
 * @returns {Promise<Buffer>}
 */
export function renderRunbookPdf(doc) {
  return new Promise((resolve, reject) => {
    // REPRODUCIBLE BYTES. pdfkit stamps a CreationDate by default, so two
    // builds of an unchanged runbook differ — which defeats the freshness guard
    // that regenerates and compares, and that guard is the whole reason the
    // served copy cannot drift from the markdown. A fixed date costs nothing:
    // the document states the source file it came from, which is the provenance
    // anyone actually wants, and "when the build ran" is not a fact about the
    // runbook.
    const EPOCH = new Date(Date.UTC(2000, 0, 1));
    const pdf = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: { Title: doc.title, CreationDate: EPOCH, ModDate: EPOCH, Producer: "MAESTRO-SMS", Creator: "MAESTRO-SMS" },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const left = PAGE.margin;
    const width = pdf.page.width - PAGE.margin * 2;

    /**
     * Write inline runs as one flowing paragraph, changing font mid-line for
     * bold, italic and code.
     *
     * `width` IS PASSED ONLY ON THE FIRST RUN. pdfkit remembers the wrap
     * boundary for the rest of a `continued` chain; passing it again re-anchors
     * the boundary to wherever the cursor now is, which silently CLIPS the run.
     * Measured on the shipped runbook: six of forty-six paragraphs containing
     * bold lost their ending mid-sentence — "the administrator config" and then
     * nothing — in a document whose whole purpose is to be relied on.
     */
    const writeRuns = (text, opts = {}) => {
      const runs = inlineRuns(text);
      const size = opts.size ?? SIZE.body;
      if (runs.length === 0) {
        pdf.text("");
        return;
      }
      // THE FIRST RUN POSITIONS EXPLICITLY, at an x this function chose.
      //
      // pdfkit leaves `x` wherever the last write finished, and a table finishes
      // in its RIGHTMOST cell. So a paragraph following a table began at that
      // column and wrapped inside the sliver of page left over — rendering as
      // "the administrator config" and then jumping, with the middle of the
      // sentence simply gone. Every paragraph that lost text followed a table,
      // which is what pointed at the cursor rather than at the wrapping.
      //
      // The width goes on the first call ONLY: pdfkit remembers the wrap
      // boundary for the rest of a `continued` chain, and passing it again
      // re-anchors it to the new cursor and clips the run.
      const startX = opts.x ?? left;
      const runWidth = opts.width ?? width - (startX - left);
      runs.forEach((r, n) => {
        const last = n === runs.length - 1;
        pdf.fontSize(r.code ? size - 0.5 : size)
          .font(r.code ? "Courier" : r.bold ? "Helvetica-Bold" : r.italic ? "Helvetica-Oblique" : opts.font ?? "Helvetica")
          .fillColor(r.href ? "#1d4ed8" : opts.color ?? INK);
        if (n === 0) {
          pdf.text(winAnsi(r.text), startX, pdf.y, {
            continued: !last,
            width: runWidth,
            link: r.href,
            underline: !!r.href,
          });
        } else {
          pdf.text(winAnsi(r.text), { continued: !last, link: r.href, underline: !!r.href });
        }
      });
      pdf.fillColor(INK).font("Helvetica");
    };

    /** Keep a block whole where it will not fit — a command split across a page
     *  break is a command somebody mis-copies at three in the morning. */
    const need = (height) => {
      if (pdf.y + height > pdf.page.height - PAGE.margin - 24) pdf.addPage();
    };

    // --- cover ---------------------------------------------------------------
    pdf.fontSize(SIZE.h1).font("Helvetica-Bold").fillColor(INK).text(winAnsi(doc.title), left);
    pdf.moveDown(0.3).fontSize(SIZE.body).font("Helvetica").fillColor(MUTED).text(winAnsi(doc.subtitle), { width });
    pdf.moveDown(0.2).fontSize(SIZE.small).text(`Generated from ${doc.source}`, { width });
    pdf.moveDown(0.5);
    pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor(RULE).lineWidth(1).stroke();
    pdf.moveDown(0.8).fillColor(INK);

    for (const b of doc.blocks) {
      switch (b.type) {
        case "heading": {
          if (b.level === 1) break; // the title is already the cover
          const size = b.level === 2 ? SIZE.h2 : SIZE.h3;
          need(size * 3);
          pdf.moveDown(b.level === 2 ? 0.7 : 0.5);
          pdf.fontSize(size).font("Helvetica-Bold").fillColor(INK);
          pdf.text(winAnsi(b.text.replace(/[`*]/g, "")), left, pdf.y, { width });
          if (b.level === 2) {
            pdf.moveDown(0.15);
            pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor(RULE).lineWidth(0.5).stroke();
          }
          pdf.moveDown(0.35);
          break;
        }
        case "para": {
          need(30);
          writeRuns(b.text);
          pdf.moveDown(0.45);
          break;
        }
        case "code": {
          const lines = b.text.split("\n");
          const lineH = SIZE.code + 2.2;
          const boxH = lines.length * lineH + 10;
          // Only jump the page for a block that can actually fit on one; a long
          // script has to break somewhere and breaking it at the top of a fresh
          // page wastes a page without helping.
          if (boxH < pdf.page.height - PAGE.margin * 2) need(boxH);
          const top = pdf.y;
          pdf.rect(left, top, width, boxH).fill(CODE_BG);
          pdf.fillColor(INK).font("Courier").fontSize(SIZE.code);
          let y = top + 5;
          for (const ln of lines) {
            if (y + lineH > pdf.page.height - PAGE.margin) {
              pdf.addPage();
              y = PAGE.margin;
              pdf.rect(left, y - 5, width, pdf.page.height - PAGE.margin - y + 5).fill(CODE_BG);
              pdf.fillColor(INK).font("Courier").fontSize(SIZE.code);
            }
            pdf.text(winAnsi(ln), left + 6, y, { width: width - 12, lineBreak: false, ellipsis: true });
            y += lineH;
          }
          pdf.y = y + 6;
          pdf.font("Helvetica").fontSize(SIZE.body).fillColor(INK);
          break;
        }
        case "list": {
          for (let n = 0; n < b.items.length; n += 1) {
            need(22);
            const marker = b.ordered ? `${n + 1}.` : "•";
            pdf.fontSize(SIZE.body).font("Helvetica").fillColor(MUTED).text(marker, left + 4, pdf.y, {
              width: 16,
              continued: false,
            });
            const y = pdf.y;
            pdf.y = y - (SIZE.body + 3);
            writeRuns(b.items[n], { x: left + 22 });
            pdf.x = left;
            pdf.moveDown(0.12);
          }
          pdf.moveDown(0.3);
          break;
        }
        case "table": {
          // ROW HEIGHT IS MEASURED, NOT ASSUMED.
          //
          // The first version fixed the height and told pdfkit not to wrap,
          // expecting an ellipsis. What it actually produced was cells written
          // over each other — "Postgres (self-hosted / compose)safety" — and a
          // table nobody could read, in a document whose only job is to be read
          // under pressure. Cells now wrap, and the row is as tall as its
          // tallest cell.
          const cols = Math.max(1, (b.head ?? b.rows[0] ?? []).length);
          const colW = width / cols;
          const pad = 4;
          const clean = (c) => winAnsi(c.replace(/[`*]/g, ""));

          const rowHeight = (cells, font, size) => {
            pdf.font(font).fontSize(size);
            return (
              Math.max(
                ...cells.map((c) => pdf.heightOfString(clean(c), { width: colW - pad * 2 })),
                size,
              ) + pad * 2
            );
          };

          const drawRow = (cells, { header }) => {
            const size = SIZE.body - 0.5;
            const font = header ? "Helvetica-Bold" : "Helvetica";
            const h = rowHeight(cells, font, size);
            // A row taller than a page cannot be kept whole; anything else is.
            if (h < pdf.page.height - PAGE.margin * 2) need(h);
            const y = pdf.y;
            if (header) pdf.rect(left, y, width, h).fill(CODE_BG);
            pdf.fillColor(INK).font(font).fontSize(size);
            cells.forEach((c, n) =>
              pdf.text(clean(c), left + n * colW + pad, y + pad, { width: colW - pad * 2 }),
            );
            pdf.y = y + h;
            pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor(RULE).lineWidth(0.3).stroke();
          };

          if (b.head) drawRow(b.head, { header: true });
          for (const row of b.rows) drawRow(row, { header: false });
          pdf.moveDown(0.5);
          pdf.font("Helvetica").fontSize(SIZE.body).fillColor(INK);
          break;
        }
        case "quote": {
          need(30);
          const top = pdf.y;
          pdf.fillColor(MUTED);
          writeRuns(b.text, { x: left + 12, color: MUTED });
          pdf.x = left;
          pdf.moveTo(left + 3, top).lineTo(left + 3, pdf.y).strokeColor(RULE).lineWidth(2).stroke();
          pdf.fillColor(INK).moveDown(0.45);
          break;
        }
        case "rule": {
          need(14);
          pdf.moveDown(0.3);
          pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).strokeColor(RULE).lineWidth(0.5).stroke();
          pdf.moveDown(0.5);
          break;
        }
        default:
          break;
      }
    }

    // --- page numbers, added once the page count is known --------------------
    //
    // THE FOOTER SITS BELOW THE BOTTOM MARGIN, and pdfkit responds to text that
    // does not fit inside the margins by ADDING A PAGE. Writing twelve footers
    // therefore produced twelve more pages, each with a footer of its own, and a
    // document whose footers read "page 1 of 12" across twenty-four pages —
    // wrong about the only fact a page number exists to state. Dropping the
    // bottom margin for the duration is what makes the write fit.
    const range = pdf.bufferedPageRange();
    const total = range.count;
    for (let n = 0; n < total; n += 1) {
      pdf.switchToPage(range.start + n);
      const bottom = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0;
      pdf.font("Helvetica").fontSize(SIZE.small).fillColor(MUTED);
      pdf.text(
        `${winAnsi(doc.title)} · page ${n + 1} of ${total}`,
        left,
        pdf.page.height - PAGE.margin + 14,
        { width, align: "center", lineBreak: false },
      );
      pdf.page.margins.bottom = bottom;
    }

    pdf.end();
  });
}
