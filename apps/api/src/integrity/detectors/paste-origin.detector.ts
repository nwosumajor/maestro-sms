// =============================================================================
// Paste-origin detector
// =============================================================================
// Flags large single-event inserts relative to the final answer. Reads the
// CLIENT PASTE telemetry already persisted for the submission and weighs each
// paste against the total content length for CONTEXT (a 500-char paste into a
// 600-char answer is very different from one into a 50k answer).
//
// Output: at most one SERVER PASTE signal summarising the pastes. Never a verdict.
// =============================================================================

import type { Detector, NewSignal, SubmissionContext } from "./types";
import {
  IntegritySignalSeverity,
  IntegritySignalType,
} from "@sms/types";

const NAME = "paste-origin@v1";

export const pasteOriginDetector: Detector = {
  name: NAME,
  run(ctx: SubmissionContext): NewSignal[] {
    const pastes = ctx.pasteEvents;
    if (pastes.length === 0) return [];

    const totalLen = Math.max(1, (ctx.submission.content ?? "").length);
    const lengths = pastes.map((p) => p.pastedLength);
    const largest = Math.max(...lengths);
    const pastedTotal = lengths.reduce((a, b) => a + b, 0);
    const largestRatio = largest / totalLen; // share of answer from one paste
    const pastedRatio = Math.min(1, pastedTotal / totalLen);

    // Thresholds are deliberately conservative priorities, not accusations.
    let severity: NewSignal["severity"] = IntegritySignalSeverity.INFO;
    if (largestRatio >= 0.5 || pastedRatio >= 0.7)
      severity = IntegritySignalSeverity.HIGH;
    else if (largestRatio >= 0.25 || pastedRatio >= 0.4)
      severity = IntegritySignalSeverity.MEDIUM;
    else if (largest >= 200) severity = IntegritySignalSeverity.LOW;

    return [
      {
        type: IntegritySignalType.PASTE,
        severity,
        confidence: Number(Math.min(1, largestRatio + pastedRatio / 2).toFixed(2)),
        detector: NAME,
        evidence: {
          pasteCount: pastes.length,
          largestPasteLength: largest,
          pastedCharsTotal: pastedTotal,
          answerLength: totalLen,
          largestPasteShareOfAnswer: Number(largestRatio.toFixed(3)),
          pastedShareOfAnswer: Number(pastedRatio.toFixed(3)),
          note: "Counts/lengths only; pasted text is never stored.",
        },
      },
    ];
  },
};
