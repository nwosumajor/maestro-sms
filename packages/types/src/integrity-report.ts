// =============================================================================
// Assessment Integrity — teacher report DTO (single source)
// =============================================================================
// The shape returned by the report endpoint and consumed by the teacher UI.
// It carries EVIDENCE for human judgement and an explicit disclaimer; it never
// carries a verdict, score, or recommended action (Golden Rule #8).
// =============================================================================

import type {
  IntegritySignalSeverity,
  IntegritySignalSource,
  IntegritySignalType,
} from "./integrity-enums";

export interface IntegrityReportSignal {
  id: string;
  type: IntegritySignalType;
  source: IntegritySignalSource;
  severity: IntegritySignalSeverity;
  /** Signal strength [0,1] — NOT probability of guilt. */
  confidence: number;
  detector: string | null;
  /** Derived-metric evidence (no raw content, no other student's work text). */
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface IntegrityReportSummary {
  total: number;
  bySeverity: Record<IntegritySignalSeverity, number>;
  byType: Partial<Record<IntegritySignalType, number>>;
  /** Highest severity present, for at-a-glance triage. Null when no signals. */
  highestSeverity: IntegritySignalSeverity | null;
}

export interface IntegrityReportDto {
  submissionId: string;
  assessmentId: string;
  assessmentTitle: string;
  studentId: string;
  status: string;
  submittedAt: string | null;
  generatedAt: string;
  summary: IntegrityReportSummary;
  /** Server + client signals, newest first. */
  signals: IntegrityReportSignal[];
  /** MUST be surfaced verbatim in any UI rendering this report. */
  disclaimer: string;
}

/** The disclaimer the API attaches and the UI must show (Golden Rule #8). */
export const INTEGRITY_REPORT_DISCLAIMER =
  "These are signals for your review, not proof of misconduct. The system takes " +
  "no automatic action and assigns no penalty. Any decision is yours to make and " +
  "will be recorded separately. Consider context, accommodations, and the student " +
  "before acting.";
