// =============================================================================
// Public service methods nobody calls
// =============================================================================
// A dead read is not neutral. It is a query somebody can wire into a controller
// in one line, and it will compile and look deliberate — and the ones left
// behind by a fix are, by definition, the version from BEFORE the fix.
//
// The scan that prompted this found six, and what they were is the argument:
//
//   sis.reviewQueue          the pre-fix profile queue: `{ profileStatus:
//                            "SUBMITTED" }` with NO supervisor scoping, over
//                            minors' pending records. `profileReviewQueue`
//                            replaced it and narrows by who may review.
//   term-result.ensureCanGrade  a wrapper so the LMS score-pull would gate on
//                            the grading rule. The pull calls getGradingRoster,
//                            which enforces canGradeClassSubject itself.
//   credits.hasBalanceInTx   superseded by a shared ALLOWANCE read once per
//                            job, which is what stops two metered channels
//                            both spending the school's last credit.
//   delegation.hasDelegation a copy of the guard's question. The guard calls
//                            hasLiveDelegation — and the two security
//                            assertions were written against the COPY, so the
//                            live path had none. They were moved, not deleted.
//   growth.resolveAgentCode  provisioning inlines the same lookup.
//
// All five are gone. The sixth is on the list below with its reason, which is
// the point of having a list: leaving one should be a decision somebody wrote
// down, not something nobody noticed.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");
const TEST = join(__dirname, "..");

/**
 * Public service methods with no caller in `src`, deliberately kept — each with
 * the reason it earns its place.
 */
const KEPT_WITHOUT_CALLERS: Record<string, string> = {
  // The READER of the attendance rollup, and a duplicate: AttendanceService
  // reads the same table inline (`useRollup`) and is what actually serves the
  // overview. Kept because it is the only place the rollup-vs-live decision is
  // written down as one testable rule, and the rollup now has a nightly sweep
  // populating it.
  "attendance/attendance-rollup.service.ts::totalsFor":
    "second reader of the rollup; AttendanceService.useRollup is the live one",
};

/** Statement keywords that can wrap onto a two-space indent and read like a
 *  method declaration to a regex. Excluded by name because the alternative —
 *  parsing TypeScript — is a great deal of machinery for a list this short. */
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "do", "else", "try"]);

/** Framework-invoked; no source file names them. */
const LIFECYCLE = new Set([
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "beforeApplicationShutdown",
]);

/** The exported class a service file declares, if it declares one. */
function className(src: string): string | null {
  return src.match(/^export class (\w+)/m)?.[1] ?? null;
}

/** The exported class's BODY, brace-matched.
 *
 *  Scanning the whole file also picked up members of an INTERFACE declared
 *  beside the class — `directory.service.ts` structurally types the user
 *  delegate with `findMany(args): Promise<unknown>`, which is not a service
 *  method anybody could call. A gate that reports something nobody can act on
 *  is one whose next reader adds an exemption. */
function classBody(src: string): string {
  const m = src.match(/^export class \w+[^{]*\{/m);
  if (!m || m.index === undefined) return "";
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return src.slice(m.index);
}

/** Every `x: TheClass` constructor property, and the file that holds it — the
 *  handle a caller actually reaches this service through. */
function propertiesTyped(cls: string, sources: Map<string, string>): { file: string; prop: string }[] {
  const out: { file: string; prop: string }[] = [];
  for (const [file, src] of sources) {
    for (const m of src.matchAll(new RegExp(`(\\w+)\\s*:\\s*${cls}\\b`, "g"))) out.push({ file, prop: m[1] });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts")) out.push(f);
  }
  return out;
}

describe("every public service method has a caller", () => {
  const srcFiles = walk(SRC);
  const sources = new Map(srcFiles.map((f) => [f, readFileSync(f, "utf8")]));
  const orphans: string[] = [];

  for (const file of srcFiles.filter((f) => f.endsWith(".service.ts"))) {
    const src = sources.get(file)!;
    const body = classBody(src);
    const rel = file.slice(SRC.length + 1);
    const re = /^ {2}(?:async\s+)?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const name = m[1];
      if (KEYWORDS.has(name) || LIFECYCLE.has(name) || name === "constructor") continue;
      const decl = body.slice(body.lastIndexOf("\n", m.index) + 1, m.index + m[0].length);
      if (/\b(private|protected)\b/.test(decl)) continue;
      // A CALLER IS A CALLER OF *THIS* SERVICE, NOT OF THAT NAME.
      //
      // This matched `.<name>(` in any other file, so a same-named method on a
      // DIFFERENT service counted as a caller and the real one was invisible.
      // Found by driving the API: `CbtService.updateBank` had been written,
      // guarded and tested, and no controller reached it — while
      // `ScholarshipAdminService.updateBank` was wired, so `.updateBank(`
      // appeared in `src` and this gate went green. A school's own question
      // bank still could not be renamed or moved between subjects.
      //
      // The same trap `every-mutation-leaves-a-trail` already records: resolving
      // a call by METHOD NAME across files makes every service with that name
      // vouch for every other. A caller now has to reach it through a property
      // whose type is THIS class.
      const cls = className(src);
      const holders = cls ? propertiesTyped(cls, sources) : [];
      const calledElsewhere = [...sources].some(([f, s]) => {
        if (f === file) return false;
        if (!new RegExp(`\\.${name}\\s*\\(`).test(s)) return false;
        // Named injection: `private readonly cbt: CbtService` -> `this.cbt.name(`
        const props = holders.filter((h) => h.file === f).map((h) => h.prop);
        if (props.some((prop) => new RegExp(`\\b${prop}\\.${name}\\s*\\(`).test(s))) return true;
        // A file that never names this class cannot be calling this class.
        return cls ? new RegExp(`\\b${cls}\\b`).test(s) : true;
      });
      const calledHere = new RegExp(`this\\.${name}\\s*\\(`).test(body);
      if (calledElsewhere || calledHere) continue;
      const key = `${rel}::${name}`;
      if (!(key in KEPT_WITHOUT_CALLERS)) orphans.push(key);
    }
  }

  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(walk(SRC).length).toBeGreaterThan(100);
  });

  it("no public service method is unreachable from anywhere in src", () => {
    expect(orphans).toEqual([]);
  });

  it("every kept-without-callers entry still exists", () => {
    // A stale exemption silently widens the rule above — the same failure mode
    // as a stale audit exemption.
    for (const key of Object.keys(KEPT_WITHOUT_CALLERS)) {
      const [rel, name] = key.split("::");
      const src = sources.get(join(SRC, rel));
      expect(src).toBeDefined();
      expect(src).toContain(name);
    }
  });
});

describe("a security property is asserted about the code that RUNS", () => {
  // `hasDelegation` was tested and dead while `hasLiveDelegation` — the one the
  // guard calls — was live and untested. That is worse than no test: the suite
  // was green about a question nobody asks.
  it("the guard's delegation check is the one under test", () => {
    const guard = readFileSync(join(SRC, "auth/permission.guard.ts"), "utf8");
    expect(guard).toMatch(/hasLiveDelegation/);
    const spec = readFileSync(join(TEST, "operator/platform-delegation.service.spec.ts"), "utf8");
    expect(spec).toMatch(/hasLiveDelegation\(/);
    expect(spec).not.toMatch(/svc\.hasDelegation\(/);
  });
});
