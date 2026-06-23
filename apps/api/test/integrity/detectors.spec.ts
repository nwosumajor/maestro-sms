// =============================================================================
// Detector tests — output is ALWAYS signals, NEVER a verdict (Golden Rule #8)
// =============================================================================

import { buildDetectors } from "../../src/integrity/detectors";
import type { SubmissionContext } from "../../src/integrity/detectors";
import { pasteOriginDetector } from "../../src/integrity/detectors/paste-origin.detector";
import { typingAnomalyDetector } from "../../src/integrity/detectors/typing-anomaly.detector";
import { draftEvolutionDetector } from "../../src/integrity/detectors/draft-evolution.detector";
import { createSimilarityDetector } from "../../src/integrity/detectors/similarity.detector";

const SEVERITIES = new Set(["INFO", "LOW", "MEDIUM", "HIGH"]);
const ALLOWED_KEYS = new Set(["type", "severity", "confidence", "evidence", "detector"]);
// Evidence keys must not name a verdict/penalty. NOTE: a bare similarity/confidence
// "score" is a MEASUREMENT (evidence), not a determination, so it's allowed — we
// match punitive concepts only, not the substring "score".
const FORBIDDEN_KEY = /grade|penal|punish|sanction|verdict|cheat|action/i;

function ctx(over: Partial<SubmissionContext>): SubmissionContext {
  return {
    submission: { id: "s", schoolId: "A", assessmentId: "a", studentId: "u", content: "x", contentKind: "PROSE" },
    drafts: [],
    pasteEvents: [],
    cadenceSamples: [],
    cohort: [],
    ...over,
  };
}

// "Blatant" inputs — would look very suspicious to a human.
const BLATANT = {
  paste: ctx({
    submission: { id: "s", schoolId: "A", assessmentId: "a", studentId: "u", content: "z".repeat(1000), contentKind: "PROSE" },
    pasteEvents: [{ pastedLength: 1000, wasBlocked: true, at: new Date().toISOString() }],
  }),
  typing: ctx({
    cadenceSamples: [{
      kind: "TYPING_CADENCE", fieldId: "f",
      windowStartedAt: new Date().toISOString(), windowEndedAt: new Date().toISOString(),
      keyCount: 500, editKeyCount: 0, meanInterKeyMs: 20, stdevInterKeyMs: 2,
      maxBurstCharsPerSec: 40, netCharDelta: 500,
    }],
  }),
  draft: ctx({ drafts: [], submission: { id: "s", schoolId: "A", assessmentId: "a", studentId: "u", content: "a complete essay", contentKind: "PROSE" } }),
  similarityCode: ctx({
    submission: { id: "s", schoolId: "A", assessmentId: "a", studentId: "u", content: "function add(a,b){return a+b;}", contentKind: "CODE" },
    cohort: [{ id: "other", studentId: "v", content: "function add(a,b){return a+b;}" }],
  }),
};

describe("detectors never emit a verdict", () => {
  it("buildDetectors returns the four detectors", () => {
    expect(buildDetectors(undefined)).toHaveLength(4);
  });

  const cases: Array<[string, () => Promise<unknown[]> | unknown[]]> = [
    ["paste-origin", () => pasteOriginDetector.run(BLATANT.paste)],
    ["typing-anomaly", () => typingAnomalyDetector.run(BLATANT.typing)],
    ["draft-evolution", () => draftEvolutionDetector.run(BLATANT.draft)],
    ["similarity(code)", () => createSimilarityDetector().run(BLATANT.similarityCode)],
  ];

  it.each(cases)("%s emits only well-formed signals, no verdict fields", async (_name, run) => {
    const signals = await run();
    expect(Array.isArray(signals)).toBe(true);
    expect(signals.length).toBeGreaterThan(0); // blatant input -> at least one signal
    for (const s of signals as Record<string, unknown>[]) {
      // shape: only the allowed signal keys, nothing resembling a punishment
      for (const k of Object.keys(s)) expect(ALLOWED_KEYS.has(k)).toBe(true);
      expect(SEVERITIES.has(s.severity as string)).toBe(true);
      expect(typeof s.confidence).toBe("number");
      expect(s.confidence as number).toBeGreaterThanOrEqual(0);
      expect(s.confidence as number).toBeLessThanOrEqual(1);
      // no boolean "cheated" anywhere, no forbidden evidence keys
      expect(typeof s.severity).not.toBe("boolean");
      for (const ek of Object.keys(s.evidence as object)) {
        expect(ek).not.toMatch(FORBIDDEN_KEY);
      }
    }
  });

  it("emit nothing (and never throw) on empty context", async () => {
    const empty = ctx({});
    expect(pasteOriginDetector.run(empty)).toEqual([]);
    expect(typingAnomalyDetector.run(empty)).toEqual([]);
    // draft-evolution flags a single-version submission, which is allowed; just
    // assert it doesn't throw and returns an array.
    expect(Array.isArray(draftEvolutionDetector.run(empty))).toBe(true);
    expect(await createSimilarityDetector().run(empty)).toEqual([]);
  });

  it("prose similarity is skipped when no embedding provider is bound", async () => {
    const prose = ctx({
      submission: { id: "s", schoolId: "A", assessmentId: "a", studentId: "u", content: "the quick brown fox", contentKind: "PROSE" },
      cohort: [{ id: "o", studentId: "v", content: "the quick brown fox" }],
    });
    expect(await createSimilarityDetector(undefined).run(prose)).toEqual([]);
  });
});
