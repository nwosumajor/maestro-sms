// =============================================================================
// Every download filename is folded, and every PDF is built by the factory
// =============================================================================
// Two rules, one cause. A `Content-Disposition` value carrying a byte outside
// Latin-1 makes Node THROW — the download becomes a 500 — and a pdfkit built-in
// font handed the same character prints a DIFFERENT letter rather than none.
//
// Both are one line to get wrong in a new controller, and neither shows up in
// testing unless somebody tests with a name from the market this is sold in.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";
import { walkSources } from "../support/api-routes";

const SRC = join(__dirname, "../../src");

// Literal filenames written into the decorator ("staff-roster.csv") are fine —
// they are ours, and they are ASCII. Only an INTERPOLATED one is user data.
const INTERPOLATED = /filename="\$\{([^}]*)\}"/g;

describe("a download name survives its header", () => {
  const files = walkSources(SRC);

  it("scanned a believable number of sources", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing — see a-gate-must-not-pass-by-finding-nothing.
    expect(files.length).toBeGreaterThan(200);
  });

  it("every interpolated Content-Disposition filename is folded", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(INTERPOLATED)) {
        seen += 1;
        // Either the interpolation calls it, or the local it names was
        // assigned from it in the same file. Demanding the call be INLINE would
        // force an awkward style at the one site that needs the value twice,
        // and a rule people have to work around is a rule people exempt.
        const expr = m[1].trim();
        const assigned = new RegExp(
          `\\b${expr.replace(/[^\w]/g, ".")}\\s*=\\s*safeFilename\\(`,
        ).test(src);
        if (!m[1].includes("safeFilename") && !assigned) {
          offenders.push(`${file.replace(SRC, "src")}: filename="\${${m[1]}}"`);
        }
      }
    }
    expect(seen).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });

  it("no PDF is built outside the folding factory", () => {
    const offenders = files
      .filter((f) => !f.endsWith("common/pdf-document.ts"))
      .filter((f) => /new PDFDocument\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(SRC, "src"));
    expect(offenders).toEqual([]);
  });

  it("found the PDF generators it exists to cover", () => {
    const generators = files.filter((f) =>
      /createPdfDocument\s*\(/.test(readFileSync(f, "utf8")),
    );
    expect(generators.length).toBeGreaterThanOrEqual(10);
  });
});
