// =============================================================================
// A name a PDF cannot print, and a header that refuses it
// =============================================================================
// Found by RUNNING a path with a name this market actually uses. Renaming a
// pupil to "Ṣadé Adéọlá Ọbi" and asking for their report card returned HTTP 500,
// "Invalid character in header content" — Node refuses a non-Latin-1 byte in a
// header value, and the filename is built from the pupil's own name. So a child
// with a Yoruba or Igbo name could not have a report card generated AT ALL.
//
// The document body fails differently and worse: pdfkit writes the codepoint's
// bytes into a single-byte string, so `Ṣ` prints as `b` and `ọ` as `Í` — a
// different name, confidently, with no error anywhere.
// =============================================================================

import { foldForPdf, foldToLatin1 } from "@sms/types";
import { safeFilename } from "../../src/documents/safe-content-type";

describe("a name a PDF cannot print", () => {
  it("folds Yoruba and Igbo letters to the base letter, never dropping the name", () => {
    expect(foldToLatin1("Ṣadé Adéọlá Ọbi")).toBe("Sadé Adéolá Obi");
    expect(foldToLatin1("Ngozi Ịheanyị")).toBe("Ngozi Iheanyi");
    // The failure being fixed: `Ṣ` must not survive as anything a single-byte
    // font renders as another letter.
    expect(foldToLatin1("Ṣadé")).not.toContain("Ṣ");
    expect(foldToLatin1("Ṣadé").startsWith("S")).toBe(true);
  });

  it("leaves a name Latin-1 can already carry exactly as typed", () => {
    for (const name of ["Zoë Müller", "José Ramírez", "Nzérékoré", "Ngozi Okonkwo"]) {
      expect(foldToLatin1(name)).toBe(name);
    }
  });

  it("produces a filename Node will accept in a header", () => {
    // Node throws on a header value carrying a byte outside Latin-1; every
    // character of the result must be inside it.
    for (const name of ["Ṣadé Adéọlá Ọbi", "Ngozi Ịheanyị", "中文名 report"]) {
      const f = safeFilename(`report-card-${name}.pdf`);
      for (const ch of f) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xff);
      expect(() => Buffer.from(f, "latin1").toString("latin1")).not.toThrow();
    }
  });

  it("never returns an empty filename, even for a name that folds away entirely", () => {
    // Nothing in "中文名" folds to a Latin letter. Dropping to "" would put a
    // bare `filename=""` in the header; the fallback is what stops that.
    expect(foldToLatin1("中文名")).toBe("");
    expect(safeFilename("中文名")).toBe("download");
  });

  it("keeps for a PDF the typographic characters WinAnsi has and a header does not", () => {
    // WinAnsi is CP1252, which fills 0x80–0x9f with the en dash, the curly
    // quotes and the ellipsis; Latin-1 leaves that range as controls. Folding
    // both the same way replaced the en dash across the grade key on every
    // report card — caught by reportcard-pdf, not by reading the spec.
    expect(foldForPdf("A 70–100 excellent")).toBe("A 70–100 excellent");
    expect(foldForPdf("Exam 60 · Midterm 20")).toBe("Exam 60 · Midterm 20");
    // A header cannot carry it, so the filename fold still must not.
    expect(foldToLatin1("A 70–100")).toBe("A 70-100");
  });

  it("folds a name the same way for both targets — neither can carry it", () => {
    expect(foldForPdf("Ṣadé Adéọlá Ọbi")).toBe("Sadé Adéolá Obi");
  });

  it("still strips what it always stripped — a header is not a place for a newline", () => {
    expect(safeFilename('a"b\nc')).toBe("abc");
  });
});
