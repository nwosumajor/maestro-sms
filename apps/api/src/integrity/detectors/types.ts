// =============================================================================
// Detector contract
// =============================================================================
// A detector is a pure-ish function over a loaded SubmissionContext that returns
// zero or more SIGNALS. It NEVER returns a boolean "cheated", a score penalty,
// or any action (Golden Rule #8). The richest thing it can say is "HIGH severity,
// here is the evidence" — a human decides what, if anything, that means.
// =============================================================================

import type {
  IntegritySignalSeverity,
  IntegritySignalType,
} from "@sms/types";
import type { TypingCadenceSample } from "@sms/types";

/** A persisted CLIENT paste signal, projected to what the detector needs. */
export interface PasteEvidence {
  pastedLength: number;
  wasBlocked: boolean;
  at: string;
}

/** Minimal shapes the detectors need — loaded by the processor within a tenant tx. */
export interface ContextSubmission {
  id: string;
  schoolId: string;
  assessmentId: string;
  studentId: string;
  content: string | null;
  contentKind: "PROSE" | "CODE";
}

export interface ContextDraft {
  sequence: number;
  contentHash: string;
  content: string | null;
  createdAt: Date;
}

/** Another submission in the same assessment/cohort (same tenant — RLS-scoped). */
export interface CohortSubmission {
  id: string;
  studentId: string;
  content: string | null;
}

export interface SubmissionContext {
  submission: ContextSubmission;
  drafts: ContextDraft[];
  /** CLIENT PASTE signals already persisted for this submission. */
  pasteEvents: PasteEvidence[];
  /** Raw client cadence telemetry (from submission_telemetry, kind TYPING_CADENCE). */
  cadenceSamples: TypingCadenceSample[];
  /** Other submissions to compare against (same assessment, same tenant). */
  cohort: CohortSubmission[];
}

/** A signal a detector wants written. submissionId/schoolId/source are filled in
 *  by the service, so a detector physically cannot mis-scope a signal. */
export interface NewSignal {
  type: IntegritySignalType;
  severity: IntegritySignalSeverity;
  /** Strength of the signal in [0,1] — NOT probability of guilt. */
  confidence: number;
  /** Evidence a teacher needs to judge. Derived metrics only, no raw content. */
  evidence: Record<string, unknown>;
  /** Detector id + version for auditability, e.g. "paste-origin@v1". */
  detector: string;
}

export interface Detector {
  readonly name: string;
  run(ctx: SubmissionContext): Promise<NewSignal[]> | NewSignal[];
}

/** Prose embedding provider — implementation wraps the configured embeddings
 *  model and is injected. Interface only here (foundation/infra concern). */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
