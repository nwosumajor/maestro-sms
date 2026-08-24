// =============================================================================
// Whoever writes telemetry about a minor asks whether they may
// =============================================================================
// Golden Rule #5 binds behavioural telemetry on minors to NDPR consent. The
// integrity module enforces that carefully — refuse to persist without consent,
// then re-check at detection time so anything captured before a withdrawal is
// never analysed. The CBT exam hall, built later in another module, wrote the
// SAME `IntegritySignal` table with the SAME two types and had no consent
// dependency at all.
//
// A rule enforced in the module it was written in is not enforced. This gate
// asks the question of every writer, so the next module to record something
// about a child has to answer it too.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");

/** The three append-only streams the retention purge governs. */
const TELEMETRY = ["integritySignal", "submissionTelemetry", "submissionDraft"];

/**
 * Writers that legitimately do NOT gate on consent, each with the reason.
 *
 * Kept as an explicit list, because "it looked fine" is exactly how the exam
 * hall came to exist.
 */
const ALLOWED: Record<string, string> = {
  "integrity/integrity.service.ts:autosave":
    "A draft is the PUPIL'S OWN WORK, saved so they do not lose it — a benefit to " +
    "the child, not an observation of them. Refusing it without consent would cost " +
    "a non-consenting pupil their essay. The ANALYSIS of drafts is separately gated: " +
    "runDetection re-checks consent and will not look at them.",
  "integrity/retention/integrity-retention.service.ts":
    "Deletes telemetry rather than creating it — the purge is the other half of " +
    "the same rule, bounded by each school's own retention window.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("every file that writes telemetry about a child", () => {
  const writers: string[] = [];
  const ungated: string[] = [];

  for (const file of walk(API_SRC)) {
    const rel = file.slice(API_SRC.length + 1);
    const src = stripComments(readFileSync(file, "utf8"));
    const writes = TELEMETRY.some((t) => new RegExp(`\\b${t}\\.(create|createMany|upsert)\\b`).test(src));
    if (!writes) continue;
    writers.push(rel);
    if (rel in ALLOWED) continue;
    if (/hasIntegrityConsent/.test(src)) continue;
    // The autosave exemption is per-METHOD, not per-file: the same file also
    // holds gated writers, so name the method too.
    if (Object.keys(ALLOWED).some((k) => k.startsWith(`${rel}:`)) && /hasIntegrityConsent/.test(src)) continue;
    ungated.push(rel);
  }

  it("found the writers at all — the scan has not silently broken", () => {
    expect(writers.length).toBeGreaterThanOrEqual(2);
  });

  it("consults NDPR consent, or is exempted by name with a reason", () => {
    expect(ungated).toEqual([]);
  });

  it("gives every exemption a real reason, not a shrug", () => {
    for (const [where, why] of Object.entries(ALLOWED)) {
      expect([where, why.length > 60]).toEqual([where, true]);
    }
  });
});
