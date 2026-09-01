import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments";

/**
 * Sixty-odd gates read a source file and assert something about it, and nearly
 * all strip comments first — because a gate scanning raw text FAILS ON THE
 * COMMENT EXPLAINING ITS OWN FIX, which quotes the defect it replaced.
 *
 * They each hand-rolled the same regex, and it hid code rather than showing it:
 * a `/*` written inside a LINE comment — "the `/cbt` routes are gated", with a
 * glob — paired with the next `*​/` in the file, which is some later JSDoc's
 * close, and every line between vanished. A `not.toMatch` over a swallowed
 * region passes VACUOUSLY, which is the "gate that passes by finding nothing"
 * failure this repo already gates against.
 */

describe("comments are removed, and nothing else is", () => {
  it("does not let a glob inside a line comment open a block", () => {
    const src = ['// the /cbt/* routes are module-gated', "const kept = 1;", "/** doc */", "const also = 2;"].join("\n");
    const out = stripComments(src);
    expect(out).toContain("const kept = 1;");
    expect(out).toContain("const also = 2;");
    expect(out).not.toContain("module-gated");
  });

  it("does not treat an apostrophe in JSX text as a string", () => {
    // The first version of this DID, and swallowed everything to the next
    // apostrophe — three gates went red on files that were perfectly correct.
    const src = ["const A = () => <p>the school's bill</p>;", "/* strip me */", "const B = 2;"].join("\n");
    const out = stripComments(src);
    expect(out).toContain("const B = 2;");
    expect(out).not.toContain("strip me");
  });

  it("keeps line numbers, so a finding can be navigated to", () => {
    const src = ["const a = 1;", "/* one", "   two */", "const b = 2;"].join("\n");
    expect(stripComments(src).split("\n")).toHaveLength(4);
  });

  it("removes both kinds, and leaves code alone", () => {
    const src = ['const a = "// not a comment";', "const b = 1; // trailing", "/* block */ const c = 2;"].join("\n");
    const out = stripComments(src);
    expect(out).toContain('const a = "// not a comment";');
    expect(out).toContain("const b = 1;");
    expect(out).toContain("const c = 2;");
    expect(out).not.toContain("trailing");
    expect(out).not.toContain("block");
  });
});

describe("no gate hand-rolls its own", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((e) => {
      const p = join(d, e);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  it("uses the one definition, so a fix here reaches every gate", () => {
    const here = join(__dirname, "strip-comments.ts");
    const offenders = walk(join(__dirname, ".."))
      .filter((f) => f.endsWith(".ts") && f !== here)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        // Either shape of the naive stripper.
        return /replace\(\s*\/\\\/\\\*\[\\s\\S\]/.test(src);
      })
      .map((f) => f.replace(join(__dirname, "..") + "/", ""));
    expect(offenders).toEqual([]);
  });

  it("the one shape it cannot see does not occur in this codebase", () => {
    // It does not track SINGLE-quoted strings, because the apostrophe in JSX
    // text is not a string opener and treating it as one swallows real code.
    // The cost is a `//` or `/*` inside a single-quoted string, which would be
    // stripped as a comment. Measured: there are none — and this fails the day
    // somebody writes one, rather than silently hiding a line from every gate.
    const roots = ["../../src", "../../../web/components", "../../../web/app", "../../../../packages/types/src"];
    const files = roots.flatMap((r) => {
      const base = join(__dirname, r);
      const walkAll = (d: string): string[] =>
        readdirSync(d).flatMap((e) => {
          if (["node_modules", ".next", "dist"].includes(e)) return [];
          const p2 = join(d, e);
          return statSync(p2).isDirectory() ? walkAll(p2) : [p2];
        });
      return walkAll(base);
    }).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(500);

    const risky = /'(?:[^'\\\n]|\\.)*(?:\/\/|\/\*)(?:[^'\\\n]|\\.)*'/;
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        // A regex character class is not a string.
        if (/\/\[/.test(line)) continue;
        // DOUBLE-quoted spans are removed FIRST: an apostrophe inside one
        // ("School Leader's Manual") is not a single-quoted string, and the
        // stripper tracks double quotes correctly anyway.
        const outsideDouble = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        if (risky.test(outsideDouble)) offenders.push(`${f}: ${t.slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scanned a believable number of gates", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing — the rule `a-gate-must-not-pass-by-finding-nothing` states.
    const files = walk(join(__dirname, "..")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(300);
    const users = files.filter((f) => readFileSync(f, "utf8").includes("stripComments"));
    expect(users.length).toBeGreaterThan(50);
  });
});
