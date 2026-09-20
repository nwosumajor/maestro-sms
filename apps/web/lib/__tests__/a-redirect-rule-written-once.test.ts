/**
 * The redirect rule is written ONCE.
 *
 * It was written three times — middleware.ts, login/page.tsx, LoginForm.tsx —
 * with the identical hand-rolled pair, and all three shared the identical
 * backslash gap. That is this repo's most-recorded shape: a control written
 * several times is right in all but one place, except here it was wrong in all
 * three, which is what a copied check buys you.
 *
 * This fails on a fourth copy. It scans for the SHAPE of the hand-rolled test
 * rather than for a blessed filename, because the next one will be in a file
 * nobody has created yet.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");
const SKIP = new Set(["node_modules", ".next", "__tests__", "coverage", ".turbo"]);
const THE_DEFINITION = join(WEB, "lib/safe-redirect.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Comments quote the defect they replaced, so a raw scan flags the fix itself. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/**
 * The hand-rolled shape: a `startsWith("/")` guard paired with a `"//"` test.
 * That pairing is only ever somebody re-deriving this rule.
 */
function handRolled(src: string): boolean {
  return /startsWith\(\s*["']\/["']\s*\)/.test(src) && /startsWith\(\s*["']\/\/["']\s*\)/.test(src);
}

describe("the redirect rule", () => {
  const files = walk(WEB);

  it("scanned the web tree at all", () => {
    // No files, no offenders — a walk that finds nothing must not pass.
    expect(files.length).toBeGreaterThan(200);
  });

  it("has exactly one home", () => {
    const src = readFileSync(THE_DEFINITION, "utf8");
    expect(src).toContain("export function safeRedirect");
    expect(src).toContain("export function isSafeRedirect");
  });

  it("is never hand-rolled anywhere else", () => {
    const offenders = files
      .filter((f) => f !== THE_DEFINITION)
      .filter((f) => handRolled(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(WEB.length + 1));
    // Named, so the failure is actionable without re-deriving which rule it is.
    expect(offenders).toEqual([]);
  });

  it("is what the three doors that had a copy actually call", () => {
    for (const f of ["middleware.ts", "app/login/page.tsx", "components/auth/LoginForm.tsx"]) {
      const src = stripComments(readFileSync(join(WEB, f), "utf8"));
      expect([f, /safeRedirect|isSafeRedirect/.test(src)]).toEqual([f, true]);
    }
  });
});
