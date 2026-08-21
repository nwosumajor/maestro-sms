// =============================================================================
// Proving an absence by searching a blob for a short number
// =============================================================================
// `expect(JSON.stringify(x)).not.toContain("5")` looks like it proves the five
// is gone. It proves no digit 5 appears anywhere in the serialised object —
// including inside the capture timestamp, a UUID, a page count, or a price that
// has nothing to do with the property.
//
// This codebase has made and fixed the same mistake three times:
//
//   retention-coverage   `not.toContain("99")`  — failed on `…45.990Z`
//   reportcard-pdf       `not.toContain("57")`  — failed under full-suite
//                                                 parallelism, passed on a
//                                                 re-run, so the next person
//                                                 spent their time proving
//                                                 their change innocent
//   scholarship signals  `not.toContain("5")`   — failed on `…23.856Z`,
//                                                 written an hour after the
//                                                 second one was fixed
//
// Each was a FALSE ALARM, which is the loud direction. The quiet direction is
// worse and the same shape: the value IS present, written differently — "1,234"
// against a search for "1234" — so the test passes while the thing it names
// leaked.
//
// The fix in every case was the same: assert the FIELD, by name. Which is why
// this is a gate rather than a note somebody is supposed to remember, having
// been written down and then repeated by the person who wrote it down.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = join(__dirname, "..");

/**
 * Short numeric needles that earn their place, each with the reason.
 *
 * A LONG literal is a different thing: "600000" inside a base64 ciphertext, or
 * "50.00" as a formatted amount, is specific enough that a coincidental match is
 * not a realistic worry. This gate is about the short ones.
 */
const ALLOWED: Record<string, string> = {};

/** Fewer characters than this and a numeric needle is mostly noise. */
const MIN_NEEDLE = 4;

function specs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) specs(f, out);
    else if (f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

describe("an absence is asserted on the field, not by searching for a number", () => {
  const offenders: string[] = [];

  for (const file of specs(TEST_ROOT)) {
    const rel = file.slice(TEST_ROOT.length + 1);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // PROSE IS NOT CODE. Both this file's own header and the comment in
        // retention-coverage quote the bad pattern in order to explain it, and
        // a gate that cannot tell an example from an assertion would force
        // every explanation to be written in riddles.
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        // Only the NEGATIVE form, and only a numeric needle: a positive
        // `toContain("5")` fails loudly when it is wrong, and a word needle
        // does not collide with a timestamp.
        const m = /\.not\.toContain\((["'`])([0-9][0-9.,]*)\1\)/.exec(line);
        if (!m) return;
        const needle = m[2];
        if (needle.length >= MIN_NEEDLE) return;
        const key = `${rel}:${i + 1}`;
        if (!(key in ALLOWED)) offenders.push(`${key}  not.toContain("${needle}")`);
      });
  }

  it("no spec proves an absence with a needle shorter than four characters", () => {
    expect(offenders).toEqual([]);
  });

  it("every allowance still points at a line that exists", () => {
    // A stale allowance silently widens the rule above — the same failure mode
    // as a stale audit or orphan-method exemption.
    for (const key of Object.keys(ALLOWED)) {
      const [rel, lineNo] = key.split(":");
      const lines = readFileSync(join(TEST_ROOT, rel), "utf8").split("\n");
      expect(lines[Number(lineNo) - 1]).toMatch(/\.not\.toContain\(/);
    }
  });
});
