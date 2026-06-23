// =============================================================================
// Assessment Integrity — client→API signal event contracts (single source)
// =============================================================================
// Shared by apps/web (emits) and apps/api (validates at the boundary). Zod is
// the boundary validator per CLAUDE.md ("Zod or class-validator"); the inferred
// types are reused everywhere so the wire shape can't drift.
//
// HARD PRIVACY RULES baked into these shapes (Golden Rule #5):
//  - We NEVER carry pasted text, typed characters, or raw keystroke streams.
//    Only DERIVED metrics (lengths, counts, durations, timings) cross the wire.
//  - The client emits factual EVENTS and telemetry SAMPLES. It never emits a
//    severity, a confidence, or a "cheated" judgement — those are decided by a
//    human after the server detectors run (Golden Rules #8).
// =============================================================================

import { z } from "zod";

/** ISO-8601 timestamp, validated as a real date. */
const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .describe("ISO-8601 timestamp");

const uuid = z.string().uuid();

/**
 * Paste attempt into an answer field. We record HOW MUCH was pasted and WHEN —
 * never WHAT. // SECURITY: storing pasted content would defeat the privacy
 * posture and could itself capture third-party PII.
 */
export const pasteCaptureEventSchema = z.object({
  kind: z.literal("PASTE"),
  fieldId: z.string().min(1),
  /** Number of characters in the paste payload. No content. */
  pastedLength: z.number().int().nonnegative(),
  /** Caret offset where the paste landed, for context. */
  caretOffset: z.number().int().nonnegative().optional(),
  /** True when the per-assessment pasteBlocked friction prevented the insert. */
  wasBlocked: z.boolean(),
  at: isoTimestamp,
});
export type PasteCaptureEvent = z.infer<typeof pasteCaptureEventSchema>;

/**
 * Focus left the assessment (tab switch / window blur). Coarse only.
 * // SECURITY: we cannot and do not observe WHERE focus went — only that it
 * left and for how long.
 */
export const focusLossEventSchema = z.object({
  kind: z.literal("FOCUS_LOSS"),
  fieldId: z.string().min(1).optional(),
  cause: z.enum(["BLUR", "VISIBILITY"]),
  startedAt: isoTimestamp,
  durationMs: z.number().int().nonnegative(),
});
export type FocusLossEvent = z.infer<typeof focusLossEventSchema>;

/**
 * Coarse typing CADENCE over a time window — derived metrics only, NOT a
 * verdict. The server's typing-anomaly detector decides whether any of this is
 * notable; the client just reports the shape of the typing.
 * // SECURITY: contains zero characters and no per-key identity beyond an
 * aggregate edit (backspace) count. This is deliberately not keylogging.
 */
export const typingCadenceSampleSchema = z.object({
  kind: z.literal("TYPING_CADENCE"),
  fieldId: z.string().min(1),
  windowStartedAt: isoTimestamp,
  windowEndedAt: isoTimestamp,
  /** Total keystrokes counted in the window (no identities). */
  keyCount: z.number().int().nonnegative(),
  /** Edits in the window — natural writing has them; their absence is a signal. */
  editKeyCount: z.number().int().nonnegative(),
  /** Mean inter-keystroke interval (ms). */
  meanInterKeyMs: z.number().nonnegative(),
  /** Std-dev of inter-keystroke interval (ms). Robotic input has low variance. */
  stdevInterKeyMs: z.number().nonnegative(),
  /** Peak typing burst seen, characters/second. */
  maxBurstCharsPerSec: z.number().nonnegative(),
  /** Net characters added to the field over the window (can be negative). */
  netCharDelta: z.number().int(),
});
export type TypingCadenceSample = z.infer<typeof typingCadenceSampleSchema>;

/** Discriminated union of everything the client may POST. */
export const clientSignalSchema = z.discriminatedUnion("kind", [
  pasteCaptureEventSchema,
  focusLossEventSchema,
  typingCadenceSampleSchema,
]);
export type ClientSignal = z.infer<typeof clientSignalSchema>;

/**
 * Batch envelope. submissionId + assessmentId are echoed for routing/validation
 * but are NEVER trusted for tenancy — the API derives school_id and verifies the
 * submission belongs to the caller from the JWT (Golden Rule #3).
 */
export const clientSignalBatchSchema = z.object({
  assessmentId: uuid,
  submissionId: uuid,
  signals: z.array(clientSignalSchema).min(1).max(200),
});
export type ClientSignalBatch = z.infer<typeof clientSignalBatchSchema>;
