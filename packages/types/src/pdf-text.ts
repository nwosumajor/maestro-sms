// =============================================================================
// Text that can survive a PDF, and a header
// =============================================================================
// pdfkit's built-in fonts are WinAnsi — a SINGLE-BYTE encoding. Handed a
// codepoint outside it, pdfkit writes the codepoint's bytes into a single-byte
// string, so the character does not go missing: it becomes DIFFERENT LETTERS.
//
// Measured against this app's own pdfkit (0.19.1), rendering
// "Ṣadé Adéọlá Ọbi" emitted <1e62 61 64 e9 20 4164 e9 1ecd 6c e1 20 1ecc 6269>
// — `Ṣ` (U+1E62) became 0x1e + 0x62 ('b'), `ọ` (U+1ECD) became 0x1e + 0xcd
// ('Í'). The card printed roughly "badé AdéÍlá Íbi".
//
// That is not a corner case where this platform is sold. Yoruba and Igbo names
// use `ọ` U+1ECD, `ṣ` U+1E63, `ị` U+1ECB as ordinary letters, and a report card
// is printed, filed in the Document Vault and emailed to guardians. Nothing
// errored, so nothing would ever have reported it.
//
// FOLD, DO NOT DROP. Deleting gives "ad" from "Ṣadé"; folding to the base letter
// gives "Sadé", which is the child's name imperfectly rather than somebody
// else's name confidently. Accented characters Latin-1 CAN represent (é, á, ü,
// ñ) are kept exactly as typed — only what cannot survive is folded, so a
// French or Spanish name is untouched.
//
// THE REAL FIX IS AN EMBEDDED UNICODE FONT and is deliberately not done here:
// it means shipping a TTF (the image has no system fonts at all) and
// registering it in all twelve PDF generators. Until then a name is folded, and
// this comment is the record of what folding costs.
// =============================================================================

function latin1(cp: number): boolean {
  // Printable ASCII plus the Latin-1 supplement — what an HTTP header can carry.
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff);
}

// GOTCHA, and a test caught me getting it wrong: **WinAnsi is NOT Latin-1.**
// CP1252 fills the 0x80–0x9f range Latin-1 leaves as controls with the
// typographic characters — the en and em dash, the curly quotes, the ellipsis,
// the bullet. So a PDF can print `A 70–100 excellent` and a HEADER cannot, and
// folding the two the same way silently replaced an en dash with a hyphen right
// across the grade key on every report card. Two targets, two functions.
const WINANSI_EXTRAS = new Set(
  "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d" +
    "\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178",
);

/**
 * Fold a string to characters a WinAnsi PDF and an HTTP header can both carry.
 *
 * Characters already representable pass through untouched. Anything else is
 * NFD-decomposed and stripped of its combining marks, which turns `Ṣ` into `S`
 * and `ọ` into `o`; whatever still cannot be represented is dropped.
 */
export function foldToLatin1(input: string): string {
  return fold(input, (ch) => latin1(ch.codePointAt(0)!));
}

/**
 * Fold a string to what a pdfkit built-in (WinAnsi) font can print.
 *
 * Strictly more permissive than {@link foldToLatin1}: the typographic
 * characters CP1252 adds are kept, so a dash stays a dash.
 */
export function foldForPdf(input: string): string {
  return fold(
    input,
    (ch) => latin1(ch.codePointAt(0)!) || WINANSI_EXTRAS.has(ch),
  );
}

function fold(input: string, keep: (ch: string) => boolean): string {
  let out = "";
  for (const ch of input.normalize("NFC")) {
    if (keep(ch)) {
      out += ch;
      continue;
    }
    // A few typographic characters have a plain equivalent that a fold misses.
    const literal = TYPOGRAPHIC[ch];
    if (literal !== undefined) {
      out += literal;
      continue;
    }
    for (const base of ch.normalize("NFD").replace(/[̀-ͯ]/g, "")) {
      if (keep(base)) out += base;
    }
  }
  return out;
}

const TYPOGRAPHIC: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  " ": " ",
  " ": " ",
  "⁠": " ",
};
