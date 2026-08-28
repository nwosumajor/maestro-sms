/**
 * Every term's report card was filed under the same name.
 *
 * `generate` built `report-card-<pupil>.pdf` whatever term was asked for, and
 * that same string is the Document Vault TITLE. So a pupil's three cards for a
 * session were filed under one identical name — a family opening their vault
 * could not tell Term 1 from Term 3 — and a principal printing a year's cards
 * got three downloads the browser numbered (1), (2), (3).
 *
 * Measured live: `POST /reportcards/:id/generate?termId=<Term 1>` returned
 * `attachment; filename="report-card-volume-pupil-75.pdf"`, while the card's own
 * heading read "Report Card — Term 1". The document always knew; only the thing
 * you file it under did not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/reportcards/reportcard.service.ts"), "utf8");
/**
 * The filename construction ALONE. A file-level search matched a `.filter(Boolean)`
 * elsewhere in this service, so removing the one that matters left the assertion
 * green — caught by mutation, not by reading.
 */
const BLOCK = SRC.slice(SRC.indexOf("const filename = ["), SRC.indexOf(".concat(\".pdf\")") + 20);

describe("a card filed under its own term", () => {
  it("puts the term in the filename", () => {
    expect(BLOCK).toMatch(/data\.termName \? slug\(data\.termName\) : null/);
  });

  it("uses that same name as the vault title, so the record matches the download", () => {
    // The vault copy is the one a family keeps. If only the download were named
    // the fix would be half done.
    const after = SRC.slice(SRC.indexOf("const filename = ["));
    expect(after).toMatch(/title: filename/);
  });

  it("still degrades to the pupil's name when no term was asked for", () => {
    // `termId` is optional and the leavers table and the plain button send none.
    // A trailing dash or an "undefined" in a filename is its own defect.
    expect(BLOCK).toMatch(/\.filter\(Boolean\)/);
    expect(BLOCK.length).toBeGreaterThan(40); // the window really found the block
  });

  it("slugs anything that is not a letter or digit", () => {
    // A session or term named "2025/2026 Term 1" must not put a slash in a
    // filename, and the header is folded for WinAnsi elsewhere for the same
    // family of reasons.
    expect(SRC).toMatch(/replace\(\/\[\^a-zA-Z0-9\]\+\/g, "-"\)/);
  });
});
