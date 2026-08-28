// =============================================================================
// A signal is never a verdict (Golden Rule #8)
// =============================================================================
// "No automated punitive action against a student. Integrity tooling produces
//  SIGNALS for human review only — never a verdict, score penalty, or record
//  entry on its own."
//
// Stated as a non-negotiable and enforced by nothing. Verified by hand when this
// gate was written and it HOLDS: of the six readers of `integrity_signal`, none
// writes a grade, a subject result or a discipline record, and the only writes
// the integrity module makes outside its own tables are the NDPR retention
// purge — a deletion obligation, not a punishment.
//
// So this fixes no defect. It exists because of what the plausible future change
// looks like: "flag a high-severity signal into the discipline module
// automatically", or "zero the score when a paste is detected". Both are one
// small commit, both read as helpful, and both are exactly what this rule
// forbids — the whole point being that a machine must not decide a child cheated.
//
// PER METHOD, not per file. `CbtService` legitimately does both: it records
// integrity events for an exam room AND it marks scripts. The rule is not "these
// may not coexist in a file" — it is that the SAME piece of work must not read a
// signal and then move a mark or open a record.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** The enclosing method of a position, bounded by the next method. */
function enclosingMethod(src: string, index: number): { name: string; body: string } | null {
  const starts = [...src.slice(0, index).matchAll(/^ {2}(?:async |private |public |protected )[\w ]*?(\w+)\s*\(/gm)];
  const last = starts.at(-1);
  if (!last) return null;
  const nextRe = /^ {2}(?:async |private |public |protected )/gm;
  nextRe.lastIndex = index;
  const next = nextRe.exec(src);
  return { name: last[1], body: src.slice(last.index ?? 0, next ? next.index : src.length) };
}

const READS_SIGNAL = /\bintegritySignal\.(?:findMany|findFirst|findUnique|count|groupBy|aggregate)\(/g;

/** A verdict: a mark moved, or a record opened against the pupil. */
const VERDICT = [
  /\bsubjectResult\.(?:create|update|upsert|createMany|updateMany)\(/,
  /\bdisciplineComplaint\.create\(/,
  /\bdisciplinaryCase\.create\(/,
  /\bdisciplineEntry\.create\(/,
  /\bcbtSitting\.update\([\s\S]{0,400}?\bscore\b/,
  /\bcbtTheoryAnswer\.update\([\s\S]{0,400}?marksAwarded/,
  // // GOTCHA: a seventh pattern, `/\bgrade:\s*[a-zA-Z]/`, was written and
  // REMOVED. It flagged `analytics.service.ts:overview`, which counts integrity
  // signals for the dashboard and builds a grade-BAND histogram —
  // `bands.map((b) => ({ grade: b.grade, count: … }))`, a read-only DTO. A
  // pattern that matches any object literal with a `grade` key is not a rule
  // about verdicts, and an over-wide gate is the same failure as a blind one:
  // it teaches whoever meets it to add an exemption, and an exemption granted
  // for a false positive is a hole with a note on it. The six writes above name
  // the actual tables a verdict would land in.
];

describe("Golden Rule #8 — a signal is never a verdict", () => {
  const files = sourceFiles(SRC);

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("found the signal readers it exists to check", () => {
    // A gate that matches nothing passes while covering nothing.
    let readers = 0;
    for (const f of files) readers += [...readFileSync(f, "utf8").matchAll(READS_SIGNAL)].length;
    expect(readers).toBeGreaterThanOrEqual(4);
  });

  it("no method that reads an integrity signal also moves a mark or opens a record", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.split("/src/")[1];
      const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(READS_SIGNAL)) {
        const enc = enclosingMethod(src, m.index ?? 0);
        if (!enc) continue;
        for (const v of VERDICT) {
          if (v.test(enc.body)) offenders.push(`${rel}:${enc.name} reads an integrity signal and then ${v.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the integrity module writes nothing outside its own tables but the retention purge", () => {
    // Its own tables plus the audit log. The retention sweep deletes telemetry
    // on the school's NDPR window, which is an obligation to FORGET rather than
    // a punishment — the one write that legitimately reaches further.
    const OWN = /integritySignal|submissionDraft|submissionTelemetry|integrityConsent|studentIntegrityExemption|assessment|submission|auditLog|integrityRetentionRun|xapiStatement|scanEvent/;
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.includes("/src/integrity/"))) {
      const rel = f.split("/src/")[1];
      const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/tx\.([a-zA-Z]+)\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\(/g)) {
        if (!OWN.test(m[1])) offenders.push(`${rel}: writes ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
