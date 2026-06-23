// =============================================================================
// Assessment Integrity — signal enums (single source, mirrors Prisma)
// =============================================================================
// These string-literal unions exactly match the Prisma enum NAMES in
// schema/integrity.prisma so api detectors, the worker, and web can share one
// vocabulary without importing the Prisma client. Keep in sync with the schema.
// =============================================================================

export const IntegritySignalType = {
  PASTE: "PASTE",
  FOCUS_LOSS: "FOCUS_LOSS",
  TYPING_ANOMALY: "TYPING_ANOMALY",
  SIMILARITY: "SIMILARITY",
  DRAFT_ANOMALY: "DRAFT_ANOMALY",
} as const;
export type IntegritySignalType =
  (typeof IntegritySignalType)[keyof typeof IntegritySignalType];

/** Reviewer-facing PRIORITY, never a guilt determination (Golden Rule #8). */
export const IntegritySignalSeverity = {
  INFO: "INFO",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;
export type IntegritySignalSeverity =
  (typeof IntegritySignalSeverity)[keyof typeof IntegritySignalSeverity];

export const IntegritySignalSource = {
  CLIENT: "CLIENT",
  SERVER: "SERVER",
} as const;
export type IntegritySignalSource =
  (typeof IntegritySignalSource)[keyof typeof IntegritySignalSource];
