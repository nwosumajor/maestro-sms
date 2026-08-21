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
  // The READER of the attendance rollup. Nothing calls it, the rollup table is
  // empty, and `refreshEndedTerms` (its writer) is reachable only by an operator
  // endpoint — so the feature is built and connected to nothing at both ends.
  // Kept rather than deleted because deleting it would make the rollup
  // write-only for certain, and whether to complete the feature or remove it is
  // a decision about a table and a schedule, not a tidy-up. Report cards compute
  // attendance live meanwhile, which is correct, just repeated.
  "attendance/attendance-rollup.service.ts::totalsFor":
    "reader of a rollup nothing writes to yet — see the report-card attendance path",
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
    const rel = file.slice(SRC.length + 1);
    const re = /^ {2}(?:async\s+)?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (KEYWORDS.has(name) || LIFECYCLE.has(name) || name === "constructor") continue;
      const decl = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index + m[0].length);
      if (/\b(private|protected)\b/.test(decl)) continue;
      const calledElsewhere = [...sources].some(
        ([f, s]) => f !== file && new RegExp(`\\.${name}\\s*\\(`).test(s),
      );
      const calledHere = new RegExp(`this\\.${name}\\s*\\(`).test(src);
      if (calledElsewhere || calledHere) continue;
      const key = `${rel}::${name}`;
      if (!(key in KEPT_WITHOUT_CALLERS)) orphans.push(key);
    }
  }

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
