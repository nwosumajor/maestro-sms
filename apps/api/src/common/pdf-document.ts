// =============================================================================
// A PDF document that cannot silently print the wrong name
// =============================================================================
// pdfkit's built-in fonts are WinAnsi, and handed a codepoint outside it pdfkit
// writes that codepoint's BYTES into a single-byte string — so `Ṣ` (U+1E62) does
// not go missing, it becomes 0x1e + 0x62 and prints as `b`. See `foldToLatin1`
// in @sms/types for the measurement and for why the fold is what it is.
//
// The fold lives HERE, at the pdfkit boundary, rather than at the places a name
// is written. There are twelve PDF generators and hundreds of `doc.text` calls
// between them; a rule applied per call site is a rule the next generator will
// be written without. Same reasoning as the gateway currency check living in
// PaystackService rather than at seven callers.
//
// `widthOfString`/`heightOfString` are wrapped too: they are how text is centred
// and wrapped, and measuring the UNFOLDED string would lay out the page for
// characters the page does not contain.
// =============================================================================

import PDFDocument from "pdfkit";
import { foldForPdf } from "@sms/types";

/**
 * Create a PDF document whose text is folded to what its fonts can carry.
 *
 * Use this everywhere instead of `new PDFDocument(...)`; a gate fails the build
 * on a bare construction.
 */
export function createPdfDocument(
  options?: PDFKit.PDFDocumentOptions,
): PDFKit.PDFDocument {
  const doc = new PDFDocument(options);
  // reason: pdfkit's overloads take the text as the first positional argument
  // and differ in the rest; forwarding them untyped is the only way to wrap all
  // of them without restating each signature.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const wrap = (name: "text" | "widthOfString" | "heightOfString") => {
    const original = (doc as any)[name].bind(doc);
    (doc as any)[name] = (value: any, ...rest: any[]) =>
      original(typeof value === "string" ? foldForPdf(value) : value, ...rest);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  wrap("text");
  wrap("widthOfString");
  wrap("heightOfString");
  return doc;
}
