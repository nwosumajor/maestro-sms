/**
 * A cohort sitting one paper is not one school flooding the API.
 *
 * The tenant limiter is keyed on `school_id` and its own header says it exists
 * "to cap pathological floods, not to shape traffic". An exam hall is the one
 * workload in this platform that is legitimately not interactive — a whole
 * cohort answering at once, because that is what an exam IS — and metering it
 * against the school's single budget let the limiter consume a candidate's
 * exam time.
 *
 * MEASURED, driven at volume: a 486-candidate two-paper sitting is ~41,000
 * requests, 34 minutes of that school's ENTIRE per-minute budget inside a
 * 90-minute window. One school's run took 7,207 refusals and finished 517 of
 * 972 papers before the window closed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiRoutes } from "../support/api-routes";
import { stripComments } from "../support/strip-comments";

const guard = stripComments(
  readFileSync(path.join(__dirname, "../../src/auth/permission.guard.ts"), "utf8"),
);

/** Every route the exam room itself calls, on BOTH surfaces. */
const EXAM_ROOM = [
  "GET /scholarships/exams/:programId/papers",
  "POST /scholarships/exams/:programId/start",
  "GET /scholarships/sittings/:id",
  "POST /scholarships/sittings/:id/answer",
  "POST /scholarships/sittings/:id/answer-theory",
  "POST /scholarships/sittings/:id/submit",
  "POST /scholarships/sittings/:id/integrity",
  "POST /cbt/exams/:id/start",
  "GET /cbt/sittings/:id",
  "POST /cbt/sittings/:id/answer",
  "POST /cbt/sittings/:id/answer-theory",
  "POST /cbt/sittings/:id/submit",
  "POST /cbt/sittings/:id/integrity",
];

describe("the limiter must not eat the exam", () => {
  it("meters every exam-room route per candidate, on BOTH surfaces", () => {
    const routes = apiRoutes();
    expect(routes.length).toBeGreaterThan(500);
    const missing: string[] = [];
    for (const key of EXAM_ROOM) {
      const r = routes.find((x) => x.key === key);
      // A route that has been renamed is a hole with a note on it — the gate
      // must fail rather than quietly cover nothing.
      if (!r) { missing.push(`${key} — no such route`); continue; }
      if (!/@PerCandidateRateLimit\(\)/.test(r.block)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  // ONE DOOR IS NOT A GUARD. The scholarship surface exists precisely because a
  // candidate at a STANDARD school cannot reach `/cbt/*`, so a fix applied to
  // one of them leaves the other cohort contending.
  it("covers the scholarship surface as well as the paid module", () => {
    expect(EXAM_ROOM.filter((k) => k.includes("/scholarships/")).length).toBeGreaterThan(4);
    expect(EXAM_ROOM.filter((k) => k.includes("/cbt/")).length).toBeGreaterThan(4);
  });

  // THE KEY MOVES, NOT THE CEILING. Each candidate keeps a full budget — far
  // more than a person can use — and the school still bounds everything else.
  it("keys the limiter on the candidate, never dropping it", () => {
    expect(guard).toMatch(/perCandidate \? `\$\{principal\.schoolId\}:\$\{principal\.userId\}` : principal\.schoolId/);
    // exactly ONE consume call: a second path is how an exemption creeps in
    expect((guard.match(/this\.rateLimit\.consume\(/g) ?? []).length).toBe(1);
  });

  // DELIBERATELY NOT AN EXEMPTION (Golden Rule #7). An unmetered exam surface
  // is the less restrictive option and there is no need for it.
  it("does not skip the limiter for these routes", () => {
    expect(guard).not.toMatch(/if \(perCandidate\) return true/);
    expect(guard).not.toMatch(/perCandidate.*skip/i);
  });
});
