// =============================================================================
// Ten copies of a comment-stripper, and the algorithm in all of them is wrong
// =============================================================================
// The API tier has one `stripComments` and a gate forcing every gate to use it,
// because the obvious two-line regex
//
//     src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
//
// silently swallows real code. Its block pattern does not know that a `/*` can
// appear where it opens nothing — inside a line comment, or inside a string — so
// a path glob written in a comment pairs with the NEXT `*/` in the file and
// takes every line between them. Measured on the API tree: 14 files lost real
// code that way, up to 44 lines at once.
//
// The web tier had NEITHER the shared function nor the gate, and NINE of its
// gates had each hand-rolled the regex in five different spellings. That is the
// sibling asymmetry this repo keeps recording: the careful half gets written on
// one side of the monorepo and the other is left. I then wrote the TENTH copy
// while fixing something else, which is how a class survives — and a grep I ran
// by hand found only five of the nine. The gate found the rest, which is the
// whole argument for having one.
//
// The dangerous direction is silent: a `not.toMatch` over a swallowed region
// passes VACUOUSLY — the gate reports the property holds because it can no
// longer see the code that would violate it.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../test-support/strip-comments";

const TESTS = join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(f)) out.push(f);
  }
  return out;
}

const FILES = walk(TESTS);

describe("no web gate hand-rolls its own comment stripper", () => {
  it("scanned the gates", () => {
    // A walk that finds nothing produces no offenders and passes green.
    expect(FILES.length).toBeGreaterThan(30);
  });

  it("uses the one definition, so a fix there reaches every gate", () => {
    const offenders = FILES.filter((f) => {
      // This file QUOTES the broken regex twice on purpose — once in the header
      // and once as the counter-example proving it really does swallow code.
      // Exempting the gate from itself is the only exemption here, and it is
      // narrow: one named file, for a reason the file demonstrates.
      if (f.endsWith("no-gate-hand-rolls-its-own-stripper.test.ts")) return false;
      const src = readFileSync(f, "utf8");
      // The block-comment half of the broken pair, in any of its spellings.
      return /replace\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(src) || /\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\/\/g/.test(src);
    }).map((f) => f.slice(TESTS.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe("and the one definition is the correct one", () => {
  it("does not let a path glob in a comment swallow the code after it", () => {
    // The exact failure. A naive stripper pairs this `/*` with the `*/` closing
    // the JSDoc below and loses `keepMe` entirely.
    const src = [
      "// the /cbt/* routes are module-gated",
      "const keepMe = 1;",
      "/** a doc comment */",
      "const alsoKeep = 2;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain("keepMe");
    expect(out).toContain("alsoKeep");
    // ...and the naive version really does lose it, so this is not a straw man.
    const naive = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(naive).not.toContain("keepMe");
  });

  it("does not mistake a URL's slashes for a comment", () => {
    const out = stripComments('const base = "http://localhost:3001"; // trailing');
    expect(out).toContain("http://localhost:3001");
    expect(out).not.toContain("trailing");
  });

  it("keeps line numbers stable, so a finding can be navigated to", () => {
    const src = "const a = 1;\n/* one\n   two\n   three */\nconst b = 2;";
    expect(stripComments(src).split("\n")).toHaveLength(src.split("\n").length);
  });

  it("leaves an apostrophe in JSX text alone", () => {
    // Single quotes are deliberately not tracked: treating the apostrophe in
    // `the school's bill` as a string opener swallows to the next one.
    const out = stripComments("<p>the school's bill</p>\nconst after = 1;");
    expect(out).toContain("after");
  });
});
