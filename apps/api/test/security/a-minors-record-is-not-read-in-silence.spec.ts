// =============================================================================
// A minor's medical record and emergency contacts are never read in silence
// =============================================================================
// Golden Rule #5: "All reads/writes to student PII ... are audit-logged."
// `every-mutation-leaves-a-trail.spec.ts` enforces the WRITE half across all 502
// mutating routes. Nothing enforced the READ half — which is the half this repo
// has already been bitten by ("two cross-tenant reads of minors' data logged
// nothing").
//
// Checked when this gate was written: all six reads of the two unambiguous
// tables audit, and the two callers of the export bundle audit the disclosure at
// their own level. So this is not fixing a defect — it makes a verified property
// hold for the SEVENTH reader, which is the one nobody will check.
//
// SCOPE IS DELIBERATELY NARROW. `medical_record` and `emergency_contact` are
// unambiguously sensitive: there is no reading of them that is not a disclosure.
// A pupil's NAME and CLASS are also personal data, and a rule demanding an audit
// row for every roster render would bury the log — the same argument this
// codebase already makes for one audit entry per gate-scan BATCH rather than per
// scan. Widening this gate to `studentProfile` would do exactly that.
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

/**
 * A read that deliberately does NOT audit, and why.
 *
 * `collectStudentBundle` is a shared collector with two callers — the per-pupil
 * NDPR export and the operator's cross-tenant bulk export — and BOTH audit the
 * disclosure themselves. Auditing here as well would double-count every export,
 * and the bulk path deliberately writes ONE entry naming the school, the count
 * and whether medical was included, rather than N entries that bury it.
 */
const AUDITED_BY_THE_CALLER: Record<string, string> = {
  "privacy/privacy.service.ts:collectStudentBundle":
    "both callers audit the disclosure at their own level; the bulk export writes one entry naming the count",
};

/** The enclosing method of a line, bounded by the next method rather than by a
 *  character count — a fixed window is how a gate stops covering what it names. */
function enclosingMethod(src: string, index: number): { name: string; body: string } | null {
  const before = src.slice(0, index);
  const starts = [...before.matchAll(/^ {2}(?:async |private |public |protected )[\w ]*?(\w+)\s*\(/gm)];
  const last = starts.at(-1);
  if (!last) return null;
  const from = last.index ?? 0;
  const nextRe = /^ {2}(?:async |private |public |protected )/gm;
  nextRe.lastIndex = index;
  const next = nextRe.exec(src);
  return { name: last[1], body: src.slice(from, next ? next.index : src.length) };
}

const READ = /\b(?:medicalRecord|emergencyContact)\.(?:findMany|findFirst|findUnique)\(/g;

describe("reading a minor's medical record or emergency contacts", () => {
  const files = sourceFiles(SRC);

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("found the reads it exists to check", () => {
    let reads = 0;
    for (const f of files) reads += [...readFileSync(f, "utf8").matchAll(READ)].length;
    expect(reads).toBeGreaterThanOrEqual(5);
  });

  it("always leaves an audit entry, or is exempted with a reason", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.split("/src/")[1];
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(READ)) {
        const enc = enclosingMethod(src, m.index ?? 0);
        if (!enc) { offenders.push(`${rel}: read outside any method`); continue; }
        if (AUDITED_BY_THE_CALLER[`${rel}:${enc.name}`]) continue;
        // `this.log(...)` is SisService's audit helper; `audit.record` is the
        // direct form used elsewhere. Either satisfies the rule.
        if (!/this\.log\(|audit\.record\(/.test(enc.body)) {
          offenders.push(`${rel}:${enc.name} reads a minor's record and writes no audit entry`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every exemption names a method that still exists", () => {
    // A dangling exemption is a hole waiting for the name to be reused.
    for (const key of Object.keys(AUDITED_BY_THE_CALLER)) {
      const [rel, method] = key.split(":");
      const src = readFileSync(join(SRC, rel), "utf8");
      expect({ key, present: new RegExp(`\\b${method}\\s*\\(`).test(src) }).toEqual({ key, present: true });
    }
  });
});
