// =============================================================================
// Draft-evolution detector
// =============================================================================
// Reads the append-only SubmissionDraft history. A believable evolution — many
// snapshots, gradual growth, edits over time — LOWERS suspicion. The opposite —
// a single fully-formed version, or one huge jump from near-empty to complete —
// RAISES it. Emits a SERVER DRAFT_ANOMALY signal with the shape of the history.
// Never a verdict; a legitimate offline-then-pasted draft can look like this and
// only a human knows the context.
// =============================================================================

import type { Detector, NewSignal, SubmissionContext } from "./types";
import {
  IntegritySignalSeverity,
  IntegritySignalType,
} from "@sms/types";

const NAME = "draft-evolution@v1";

const len = (s: string | null) => (s ? s.length : 0);

export const draftEvolutionDetector: Detector = {
  name: NAME,
  run(ctx: SubmissionContext): NewSignal[] {
    const drafts = [...ctx.drafts].sort((a, b) => a.sequence - b.sequence);
    const finalLen = len(ctx.submission.content);
    if (finalLen === 0) return [];

    // Largest single growth between consecutive snapshots, as a share of final.
    let prevLen = 0;
    let biggestJump = 0;
    for (const d of drafts) {
      const delta = len(d.content) - prevLen;
      if (delta > biggestJump) biggestJump = delta;
      prevLen = len(d.content);
    }
    // If the very first observed state is already near-complete, that's a jump too.
    const firstLen = drafts.length > 0 ? len(drafts[0].content) : finalLen;
    biggestJump = Math.max(biggestJump, firstLen);

    const jumpShare = biggestJump / finalLen;
    const draftCount = drafts.length;

    // Distinct content states (by hash) — repeated identical autosaves don't count.
    const distinctStates = new Set(drafts.map((d) => d.contentHash)).size;

    const reasons: string[] = [];
    if (draftCount <= 1) reasons.push("single-version");
    if (jumpShare >= 0.8) reasons.push("one-large-jump");
    if (distinctStates <= 1) reasons.push("no-evolution");

    if (reasons.length === 0) return [];

    let severity: NewSignal["severity"] = IntegritySignalSeverity.LOW;
    if (reasons.length >= 2) severity = IntegritySignalSeverity.HIGH;
    else if (reasons.includes("single-version") || reasons.includes("one-large-jump"))
      severity = IntegritySignalSeverity.MEDIUM;

    return [
      {
        type: IntegritySignalType.DRAFT_ANOMALY,
        severity,
        confidence: Number(Math.min(1, reasons.length / 3).toFixed(2)),
        detector: NAME,
        evidence: {
          reasons,
          draftCount,
          distinctContentStates: distinctStates,
          finalLength: finalLen,
          largestSingleJumpChars: biggestJump,
          largestJumpShareOfFinal: Number(jumpShare.toFixed(3)),
          note: "Believable edit history lowers, not proves, suspicion.",
        },
      },
    ];
  },
};
