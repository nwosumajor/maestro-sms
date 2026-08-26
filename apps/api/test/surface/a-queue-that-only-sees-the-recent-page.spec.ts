// =============================================================================
// A queue that can only see the recent page
// =============================================================================
// A screen asks "is anything waiting on us?" and answers it with a `.filter()`
// over a list the API capped. That is safe for a QUEUE of live work and wrong
// for a REVIEW QUEUE, because the two properties combine badly:
//
//   a row is PENDING precisely because nobody has dealt with it, so pending
//   rows AGE — and a `take: N` ordered newest-first drops the OLDEST first.
//
// So the rows the filter exists to surface are exactly the rows it cannot see,
// and the screen renders a confident "Nothing awaiting review."
//
// Measured live on one term of a 901-pupil school: `subject_selection` held 21
// selections awaiting approval, `GET /subject-selections` returned 200 rows,
// EVERY ONE of them APPROVED, and the review panel rendered "Nothing awaiting
// review." Worse, that list was ordered by `updatedAt`, which a REVIEW bumps —
// so working through the queue pushed the rest of it further out of sight. And
// only APPROVED selections feed the grading roster, so those 21 pupils were
// also missing from it.
//
// Third and fourth instances of a class already recorded here for the
// chargeback banner and the admissions queue.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "..", "web");

/**
 * A component may split a list in memory ONLY when the service guarantees the
 * list contains every open row. Each of these is paired with a case in "the
 * services behind those screens" below, which is what holds that guarantee in
 * place — the exemption and its enforcement are not separable.
 */
const ALLOWED: Record<string, string> = {
  "components/admin/ParentOnboard.tsx":
    "ParentImportService.list returns every PENDING batch oldest-first, then recent history",
  "components/admin/SisImport.tsx":
    "StudentImportService.list returns every PENDING batch oldest-first, then recent history",
  "components/lms/PromotionManager.tsx":
    "PromotionService.list returns every PENDING batch oldest-first, then recent history",
  "components/operator/OnboardingRequests.tsx":
    "listOnboardingRequests returns every NEW/REVIEWING request oldest-first, then recent history",
};

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "dist") continue;
    const p = join(dir, e);
    out = statSync(p).isDirectory() ? out.concat(walk(p)) : p.endsWith(".tsx") ? out.concat(p) : out;
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * `x.filter(r => r.status === "PENDING…")` and friends — a set of rows still
 * awaiting somebody, derived in the BROWSER from whatever the API sent.
 */
const WAITING = /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>[^\n]*\.status\s*===\s*"(PENDING[A-Z_]*|NEW|REVIEWING|OPEN|SUBMITTED)"/;

describe("a screen that says what is waiting", () => {
  const files = walk(join(WEB, "components")).concat(walk(join(WEB, "app")));

  it("scanned the web tree at all", () => {
    // Without this, a moved directory turns every assertion below green while
    // covering nothing — the rule `a-gate-must-not-pass-by-finding-nothing`.
    expect(files.length).toBeGreaterThan(200);
  });

  it("found the shape it is looking for, somewhere", () => {
    // The pattern itself must still match real code, or a refactor of how these
    // components are written silently retires the gate.
    const anyStatusFilter = files.filter((f) => /\.filter\([^\n]*\.status\s*===/.test(readFileSync(f, "utf8")));
    expect(anyStatusFilter.length).toBeGreaterThan(0);
  });

  it("never derives it from a list the API capped", () => {
    const offenders = files
      .filter((f) => WAITING.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.slice(WEB.length + 1))
      .filter((rel) => !(rel in ALLOWED));
    // Each of these must instead read a server-counted total, or be handed a
    // list the service guarantees contains every open row.
    expect(offenders).toEqual([]);
  });

  it("gives every exemption a reason, and none that is now unused", () => {
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(files.some((f) => f.endsWith(rel))).toBe(true);
    }
  });
});

/**
 * The other half of the rule, on the API side: a service whose list a screen
 * splits by status must ASK the database for the open rows, not slice a page
 * and hope.
 */
describe("the services behind those screens", () => {
  const API = join(__dirname, "..", "..", "src");
  const QUEUES: Array<{ file: string; model: string; method: string }> = [
    { file: "gradebook/subject-selection.service.ts", model: "subjectSelection", method: "list" },
    { file: "meeting/meeting-request.service.ts", model: "meetingRequest", method: "list" },
    { file: "lms/promotion.service.ts", model: "promotionBatch", method: "list" },
    { file: "admin/student-import.service.ts", model: "studentImportBatch", method: "list" },
    { file: "parent/parent-import.service.ts", model: "parentImportBatch", method: "list" },
    { file: "operator/operator-provisioning.service.ts", model: "onboardingRequest", method: "listOnboardingRequests" },
  ];

  /** The named method's body, brace-matched — not the whole file. */
  function methodBody(src: string, method: string): string {
    const at = src.search(new RegExp(`\\basync ${method}\\s*\\(`));
    expect(at).toBeGreaterThan(-1);
    const open = src.indexOf("{", src.indexOf(")", at));
    let d = 1, i = open + 1;
    while (i < src.length && d > 0) { if (src[i] === "{") d++; else if (src[i] === "}") d--; i++; }
    return src.slice(open, i);
  }

  it.each(QUEUES)("$model narrows to the open rows in SQL", ({ file, model, method }) => {
    // The LIST METHOD's own body. Anchoring to the file passed with the
    // narrowing deleted, because these files mention a status and a `PENDING`
    // somewhere else — a gate looking one scope too wide is the same failure as
    // one looking one scope too narrow, and only mutation testing tells them
    // apart.
    const src = methodBody(stripComments(readFileSync(join(API, file), "utf8")), method);
    expect(src).toContain(`${model}.findMany`);
    // A read of this model that mentions a waiting status in its own `where`.
    // Two of the six build the narrowing into a `where` object a few lines
    // above the call rather than inline, so this looks at the method, not at
    // the `findMany` block.
    expect(src).toMatch(/status:\s*\{\s*(in|notIn|not):|status:\s*"(PENDING|NEW|REVIEWING)"/);
    // …and it must say WHICH statuses mean "still waiting", or a `status:`
    // narrowing something else entirely would satisfy the line above.
    expect(src).toMatch(/PENDING|REVIEWING|UNDECIDED|OPEN_/);
  });
});
