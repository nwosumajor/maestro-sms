// =============================================================================
// One school's failure ended the whole fleet's sweep
// =============================================================================
// Eleven scheduled jobs run across every school on the platform. Three of them
// guard each school — the late-fee sweep, the attendance rollup and the
// message-credit reconciliation all catch, count and carry on. Two did not:
//
//   integrity-retention   for (const s of schools) results.push(await purgeSchool(...))
//   billing-dunning       for (const s of subs)    { ...charge, flip, notify... }
//
// Unguarded, the first school that throws abandons every school after it — and
// in retention's case the PLATFORM-WIDE streams below the loop too (gateway
// events, read notifications, old job runs). It would fail the same way every
// night, so the damage is not one missed night: it is indefinite.
//
// What that means is specific to each. Retention exists to delete minors'
// behavioural telemetry once its window has passed, so a stalled sweep is data
// retained beyond the period the school told parents about. Dunning flips lapsed
// subscriptions to PAST_DUE and sends the renewal notice, so a stalled sweep is
// schools that are never chased and never told.
//
// Both now catch per item, name the school in the log, and COUNT the failure
// into the returned result — the job-runs catalogue is what an operator reads,
// and "12 scanned, 3 reminded" while four schools threw reads as a quiet night.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const RETENTION = readFileSync(
  join(__dirname, "../../src/integrity/retention/integrity-retention.service.ts"),
  "utf8",
);
const DUNNING = readFileSync(join(__dirname, "../../src/billing/billing-dunning.service.ts"), "utf8");

/** The body of the per-school loop in `src`, from `for (` to its closing brace. */
function loopBody(src: string, header: string): string {
  const start = src.indexOf(header);
  expect([header, start]).not.toEqual([header, -1]);
  return src.slice(start, start + 3000);
}

describe("a fleet-wide sweep", () => {
  it("catches a failing school in the retention purge", () => {
    const body = loopBody(RETENTION, "for (const s of schools) {");
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/catch \(err\)/);
  });

  it("catches a failing school in the dunning run", () => {
    const body = loopBody(DUNNING, "for (const s of subs) {");
    expect(body).toMatch(/try \{/);
    expect(body).toMatch(/catch \(err\)/);
  });

  it("names the school in the log, so the same one failing nightly is findable", () => {
    // A count alone says four schools failed and never which; the one that
    // fails every night is the one worth fixing.
    expect(loopBody(RETENTION, "for (const s of schools) {")).toMatch(/school \$\{s\.id\}/);
    expect(loopBody(DUNNING, "for (const s of subs) {")).toMatch(/school \$\{s\.schoolId\}/);
  });

  it("COUNTS the failures into the returned result, not just the log", () => {
    // The job-runs catalogue is what an operator reads. A sweep reporting
    // success while skipping four schools is worse than one that fails loudly.
    expect(RETENTION).toMatch(/failed \+= 1/);
    expect(RETENTION).toMatch(/return \{ schools: results, failed,/);
    // DUNNING counts SCHOOLS, not incidents.
    //
    // This asserted the literal `failed += 1` and went red when the counter
    // became a Set — the fixed-text failure mode this repo keeps recording,
    // firing on a change that made the count STRONGER rather than weaker. The
    // sweep now has two ways to fail a school (its dunning, or its seat-arrears
    // accrual) and one that fails both must be reported once, which an
    // increment cannot express.
    expect(DUNNING).toMatch(/failedSchools\.add\(s\.schoolId\)/);
    expect(DUNNING).toMatch(/failed: failedSchools\.size/);
  });

  it("counts the SEAT-ARREARS accrual too — it used to be outside the tally", () => {
    // The accrual loop sits ABOVE the per-school guard and was left inside a
    // single try/catch: one school it could not price abandoned every school
    // after it, and `failed` knew nothing, so the jobs console showed a clean
    // green run while the platform metered no seat growth at all. Proved live
    // with a GHS school and an ordinary naira one — both accrued nothing.
    const body = loopBody(DUNNING, "for (const s of subs) {");
    // The accrual's own loop, which comes first in the file.
    expect(DUNNING).toMatch(/failedSchools\.push\(s\.schoolId\)/);
    expect(DUNNING).toMatch(/seat-arrears accrual failed school=/);
    // And its failures reach the returned result.
    expect(DUNNING).toMatch(/arrearsFailed: arrearsFailedSchools\.length/);
    expect(DUNNING).toMatch(/new Set<string>\(arrearsFailedSchools\)/);
    // The dunning loop is still guarded per school (unchanged property).
    expect(body).toMatch(/catch \(err\)/);
  });

  it("declares the count on the result TYPE, so a caller cannot ignore it silently", () => {
    expect(DUNNING).toMatch(/failed: number;/);
    expect(RETENTION).toMatch(/failed: number;/);
  });

  it("lets the platform-wide purge run even when a school failed", () => {
    // gateway events, read notifications and old job runs are swept once, AFTER
    // the loop. Unguarded, a single school took them down too — and those are
    // the streams nobody is watching.
    const loopAt = RETENTION.indexOf("for (const s of schools) {");
    const platformAt = RETENTION.indexOf("purgePlatformWide()");
    expect(loopAt).toBeLessThan(platformAt);
    expect(loopBody(RETENTION, "for (const s of schools) {")).toMatch(/catch \(err\)/);
  });
});

// ---------------------------------------------------------------------------

// A COUNT NOBODY SURFACES IS A COUNT NOBODY ACTS ON.
//
// Catching per school is what stops the sweep throwing — so `lastOk` stays TRUE,
// `overdue` is false, `overrunning` is false, and the operator's jobs console
// showed a run that skipped four schools as healthy. The console's own health
// test was `neverRun || overdue || lastOk === false || overrunning`, and a
// partial run is none of those.

import { readFileSync as read } from "node:fs";

const JOB_RUNS = read(join(__dirname, "../../src/maintenance/job-runs.service.ts"), "utf8");
const JOBS_TABLE = read(join(__dirname, "../../../web/components/operator/JobsTable.tsx"), "utf8");

describe("what the operator sees after a partial run", () => {
  it("reads the job's own failed count out of the stored summary", () => {
    expect(JOB_RUNS).toMatch(/function failedCount/);
    expect(JOB_RUNS).toMatch(/lastFailed: failedCount\(last\?\.summary\)/);
  });

  it("treats a missing count as absent, not as zero", () => {
    // A job with no notion of a partial failure reports nothing, which is a
    // different fact from "it failed for nobody" — and a non-numeric value must
    // not become a permanent alarm nobody can clear.
    expect(JOB_RUNS).toMatch(/typeof value === "number" && Number\.isFinite\(value\)/);
    expect(JOB_RUNS).toMatch(/lastFailed: number \| null;/);
  });

  it("counts a partial run as UNHEALTHY on the console", () => {
    expect(JOBS_TABLE).toMatch(/\(j\.lastFailed \?\? 0\) > 0/);
    const wrongAt = JOBS_TABLE.indexOf("const wrong = (j: JobStatus)");
    expect(JOBS_TABLE.slice(wrongAt, wrongAt + 260)).toMatch(/lastFailed/);
  });

  it("says what was left undone, rather than only that something was", () => {
    // "Partial" alone sends somebody to the logs to find out whether it was one
    // school or forty.
    expect(JOBS_TABLE).toMatch(/could not be/);
    expect(JOBS_TABLE).toMatch(/left as they were/);
  });
});
