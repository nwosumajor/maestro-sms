// =============================================================================
// A fleet sweep that catches PER SCHOOL must COUNT what it could not do
// =============================================================================
// `JobRunsService` documents the convention and reads the field by name:
//
//   "A CROSS-TENANT SWEEP THAT CATCHES PER SCHOOL DOES NOT THROW, so `lastOk` is
//    true and every other signal here is clean: a run that skipped four schools
//    was indistinguishable from a run that did the whole fleet ... a count
//    nobody surfaces is a count nobody acts on."
//
// The dunning run, the retention purge and mobile-money recovery counted theirs.
// FOUR did not, and the operator's jobs console — the page built precisely so a
// quiet sweep is visible — showed null for every one of them:
//
//   hostel.exeatOverdue   a per-school catch on the sweep that exists to notice
//                         a child who has not come back to the boarding house
//   hr.staffReminders     two per-school catches, one of them in a void method
//                         whose failures could not reach the result at all
//   attendance.rollup     counted a FAILURE as `skipped`, which the convention
//                         above explicitly says is a different thing
//   fees.reconciliation   per-charge catches — money left unrecovered, reported
//                         as a clean run
//
// THE SET IS COMPUTED, not listed. Every BullMQ processor names the service it
// drives, so the processors are walked and each service is checked: if it
// catches and logs without rethrowing, its result must carry `failed`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every service a background processor drives, resolved from its imports. */
function sweepServices(): Array<{ processor: string; service: string; src: string }> {
  const out: Array<{ processor: string; service: string; src: string }> = [];
  for (const proc of walk(SRC).filter((f) => f.endsWith(".processor.ts"))) {
    const text = readFileSync(proc, "utf8");
    for (const m of text.matchAll(/import\s+\{[^}]*\}\s+from\s+"(\.[^"]+\.service)"/g)) {
      const file = resolve(dirname(proc), `${m[1]}.ts`);
      if (existsSync(file)) out.push({ processor: proc, service: m[1], src: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/** A catch that swallows: logs, and does not rethrow. That is what makes a
 *  partial failure invisible to everything except the field this gate is about. */
function swallowsPerItem(src: string): boolean {
  for (const m of src.matchAll(/\}\s*catch\s*\([^)]*\)\s*\{([\s\S]{0,400}?)\n\s*\}/g)) {
    const body = m[1];
    if (/this\.logger\.(warn|error)/.test(body) && !/throw/.test(body)) return true;
  }
  return false;
}

describe("a fleet sweep that skipped a school says so", () => {
  const services = sweepServices();

  it("found the processors it is about", () => {
    // A walk that finds no files produces no offenders and passes green.
    expect(services.length).toBeGreaterThan(5);
  });

  it("counts what it could not do, in the field the jobs console reads", () => {
    // The predicate is a CONJUNCTION on purpose. An earlier draft asked for a
    // `failed:` field AND a `failed++` and flagged six services that were
    // already correct — an over-wide gate is the same failure as a blind one,
    // because it teaches its next reader to add an exemption.
    // THE INCREMENT IS THE EVIDENCE, not the declaration. Asked only for a
    // `failed:` field, this passed a mutation that kept the field and stopped
    // counting into it — which is the whole defect wearing the fix's clothes.
    // The three idioms in this codebase: a counter, a Set of school ids, and
    // `result.failed++`.
    const reportsFailures = (src: string) =>
      /\bfailed\w*\s*(\+\+|\+=)/.test(src) ||
      /\bfailed\w*\.add\(/.test(src) ||
      /\bfailed:\s*[\w.]+\.size/.test(src);
    const offenders = services
      // JobRunsService is the RECORDER, not a sweep: it is what reads `failed`.
      .filter((s) => !s.service.endsWith("job-runs.service"))
      .filter((s) => swallowsPerItem(s.src) && !reportsFailures(s.src))
      .map((s) => s.service);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("does not fold a failure into `skipped`, which means something else", () => {
    // The convention is narrow on purpose: `skipped` is work that was NOT DUE.
    // A sweep that increments it in a catch reports a failure as normality.
    for (const s of services) {
      for (const m of s.src.matchAll(/\}\s*catch\s*\([^)]*\)\s*\{([\s\S]{0,200}?)\n\s*\}/g)) {
        expect(`${s.service}: ${m[1].trim().slice(0, 60)}`).not.toMatch(/skipped\+\+/);
      }
    }
  });

  it("still reads the count by name, so the console can find it", () => {
    const jobRuns = stripComments(readFileSync(join(SRC, "maintenance/job-runs.service.ts"), "utf8"));
    expect(jobRuns).toMatch(/\(summary as \{ failed\?: unknown \}\)\.failed/);
    expect(jobRuns).toMatch(/lastFailed: failedCount\(/);
  });
});
