// =============================================================================
// Typing-anomaly detector
// =============================================================================
// Natural writing has rhythm: variable inter-key intervals, pauses, and edits.
// Robotic/pasted-then-retyped input tends to be low-variance, edit-free, or
// implausibly fast. This detector reads the CLIENT TYPING_CADENCE samples and
// flags those shapes. It does NOT conclude anything — it raises a SERVER
// TYPING_ANOMALY signal with the metrics for a teacher to weigh.
//
// // SECURITY: operates purely on derived metrics. There is no content here to
// analyse, by construction of the wire format.
// =============================================================================

import type { Detector, NewSignal, SubmissionContext } from "./types";
import {
  IntegritySignalSeverity,
  IntegritySignalType,
} from "@sms/types";

const NAME = "typing-anomaly@v1";

// A burst faster than this is hard to sustain by hand for real composition.
const IMPLAUSIBLE_BURST_CPS = 18;
// Very low timing variance suggests non-human/auto input.
const LOW_VARIANCE_MS = 12;

export const typingAnomalyDetector: Detector = {
  name: NAME,
  run(ctx: SubmissionContext): NewSignal[] {
    const samples = ctx.cadenceSamples;
    if (samples.length === 0) return [];

    let totalKeys = 0;
    let totalEdits = 0;
    let maxBurst = 0;
    let minStdev = Number.POSITIVE_INFINITY;
    for (const s of samples) {
      totalKeys += s.keyCount;
      totalEdits += s.editKeyCount;
      maxBurst = Math.max(maxBurst, s.maxBurstCharsPerSec);
      if (s.keyCount >= 5) minStdev = Math.min(minStdev, s.stdevInterKeyMs);
    }
    if (totalKeys === 0) return [];

    const editRatio = totalEdits / totalKeys;
    const lowVariance = minStdev !== Number.POSITIVE_INFINITY && minStdev <= LOW_VARIANCE_MS;
    const implausibleBurst = maxBurst >= IMPLAUSIBLE_BURST_CPS;
    const noEdits = editRatio < 0.02; // human prose almost always has edits

    const reasons: string[] = [];
    if (implausibleBurst) reasons.push("implausible-burst");
    if (lowVariance) reasons.push("low-timing-variance");
    if (noEdits) reasons.push("near-zero-edits");
    if (reasons.length === 0) return [];

    let severity: NewSignal["severity"] = IntegritySignalSeverity.LOW;
    if (reasons.length >= 2) severity = IntegritySignalSeverity.HIGH;
    else if (implausibleBurst || lowVariance) severity = IntegritySignalSeverity.MEDIUM;

    return [
      {
        type: IntegritySignalType.TYPING_ANOMALY,
        severity,
        confidence: Number(Math.min(1, reasons.length / 3).toFixed(2)),
        detector: NAME,
        evidence: {
          reasons,
          totalKeystrokes: totalKeys,
          editRatio: Number(editRatio.toFixed(3)),
          maxBurstCharsPerSec: maxBurst,
          minStdevInterKeyMs: minStdev === Number.POSITIVE_INFINITY ? null : minStdev,
          sampleWindows: samples.length,
        },
      },
    ];
  },
};
