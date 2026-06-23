"use client";

// =============================================================================
// Assessment Integrity — client capture hooks
// =============================================================================
// Three small capture primitives (paste / focus-loss / typing-cadence) and one
// orchestrator that wires them to an answer field according to the resolved
// per-assessment + per-student configuration.
//
// GATING (most-restrictive-wins). Instrumentation runs ONLY when ALL hold:
//   integrityEnabled  — master switch for this assessment
//   consentGranted    — NDPR consent on file for this minor (Golden Rule #5)
//   !exempt           — no active accessibility exemption for this student
// Each individual capture is then additionally gated by its own toggle.
//
// EXEMPTION SEMANTICS. // SECURITY: an exempt student gets NEITHER friction NOR
// surveillance. We chose the more restrictive interpretation of the spec
// ("skip friction, still allow through"): instrumenting an accommodation would
// itself be discriminatory, so we instrument nothing. The student proceeds with
// a plain field. Telling apart "exempt" from "monitoring off" is intentional.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  FocusLossEvent,
  PasteCaptureEvent,
  TypingCadenceSample,
} from "@sms/types/integrity";
import { IntegritySignalClient } from "./signalClient";

export interface IntegrityClientConfig {
  apiBaseUrl: string;
  assessmentId: string;
  submissionId: string;
  /** Master switch (Assessment.integrityEnabled). */
  integrityEnabled: boolean;
  /** NDPR consent for this minor, resolved server-side. */
  consentGranted: boolean;
  /** Active StudentIntegrityExemption resolved server-side. */
  exempt: boolean;
  /** Per-assessment friction/capture toggles. */
  toggles: {
    /** Assessment.pasteBlocked — capture pastes (and prevent insert as friction). */
    pasteCapture: boolean;
    /** Assessment.focusTracked. */
    focusTracking: boolean;
    /** Assessment.typingTracked. */
    typingCadence: boolean;
  };
}

/** Whether ANY instrumentation may run for this student/assessment. */
export function isMonitoringActive(cfg: IntegrityClientConfig): boolean {
  return cfg.integrityEnabled && cfg.consentGranted && !cfg.exempt;
}

const now = () => new Date().toISOString();

// -----------------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------------
export interface AssessmentIntegrity {
  /** True when the student must be shown the monitoring disclosure banner. */
  active: boolean;
  /** Whether paste friction is in effect (capture is on AND blocking enabled). */
  pasteFriction: boolean;
  /** Spread onto the answer <textarea>/<input>. */
  fieldProps: {
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  };
}

export function useAssessmentIntegrity(
  fieldId: string,
  cfg: IntegrityClientConfig,
): AssessmentIntegrity {
  const active = isMonitoringActive(cfg);

  // One transport per submission, created only when active.
  const clientRef = useRef<IntegritySignalClient | null>(null);
  useEffect(() => {
    if (!active) return;
    const client = new IntegritySignalClient({
      apiBaseUrl: cfg.apiBaseUrl,
      assessmentId: cfg.assessmentId,
      submissionId: cfg.submissionId,
    });
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [active, cfg.apiBaseUrl, cfg.assessmentId, cfg.submissionId]);

  // --- focus-loss tracking (visibilitychange + window blur) ---
  const blurStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !cfg.toggles.focusTracking) return;

    const markLeft = () => {
      if (blurStartRef.current == null) blurStartRef.current = Date.now();
    };
    const markReturned = (cause: FocusLossEvent["cause"]) => {
      const start = blurStartRef.current;
      if (start == null) return;
      blurStartRef.current = null;
      const evt: FocusLossEvent = {
        kind: "FOCUS_LOSS",
        fieldId,
        cause,
        startedAt: new Date(start).toISOString(),
        durationMs: Date.now() - start,
      };
      clientRef.current?.enqueue(evt);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") markLeft();
      else markReturned("VISIBILITY");
    };
    const onBlur = () => markLeft();
    const onFocus = () => markReturned("BLUR");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, cfg.toggles.focusTracking, fieldId]);

  // --- typing cadence accumulator (derived metrics only) ---
  // SECURITY: we store keystroke TIMESTAMPS and an edit flag only. We never read
  // e.key for its character. No content, no per-key identity.
  const cadence = useRef({
    windowStart: Date.now(),
    timestamps: [] as number[],
    editKeys: 0,
    netCharDelta: 0,
    lastLen: 0,
  });

  const flushCadence = useCallback(() => {
    const c = cadence.current;
    if (c.timestamps.length < 2) {
      // reset window even if too small to summarise
      c.windowStart = Date.now();
      c.timestamps = [];
      c.editKeys = 0;
      c.netCharDelta = 0;
      return;
    }
    const intervals: number[] = [];
    for (let i = 1; i < c.timestamps.length; i++) {
      intervals.push(c.timestamps[i] - c.timestamps[i - 1]);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    // peak burst: smallest interval -> fastest chars/sec
    const minInterval = Math.max(1, Math.min(...intervals));
    const sample: TypingCadenceSample = {
      kind: "TYPING_CADENCE",
      fieldId,
      windowStartedAt: new Date(c.windowStart).toISOString(),
      windowEndedAt: now(),
      keyCount: c.timestamps.length,
      editKeyCount: c.editKeys,
      meanInterKeyMs: Math.round(mean),
      stdevInterKeyMs: Math.round(Math.sqrt(variance)),
      maxBurstCharsPerSec: Number((1000 / minInterval).toFixed(2)),
      netCharDelta: c.netCharDelta,
    };
    clientRef.current?.enqueue(sample);
    c.windowStart = Date.now();
    c.timestamps = [];
    c.editKeys = 0;
    c.netCharDelta = 0;
  }, [fieldId]);

  useEffect(() => {
    if (!active || !cfg.toggles.typingCadence) return;
    const id = setInterval(flushCadence, 20_000);
    return () => {
      clearInterval(id);
      flushCadence();
    };
  }, [active, cfg.toggles.typingCadence, flushCadence]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!active || !cfg.toggles.typingCadence) return;
      cadence.current.timestamps.push(Date.now());
      if (e.key === "Backspace" || e.key === "Delete") {
        cadence.current.editKeys += 1;
      }
    },
    [active, cfg.toggles.typingCadence],
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!active || !cfg.toggles.typingCadence) return;
      const len = e.target.value.length;
      cadence.current.netCharDelta += len - cadence.current.lastLen;
      cadence.current.lastLen = len;
    },
    [active, cfg.toggles.typingCadence],
  );

  // --- paste capture (+ optional friction) ---
  const pasteFriction = active && cfg.toggles.pasteCapture;
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (!active || !cfg.toggles.pasteCapture) return; // exempt/off -> normal paste
      const text = e.clipboardData.getData("text");
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      // Friction only: prevent the insert, but this is NOT enforcement — the
      // server treats the captured signal, not this block, as the record.
      e.preventDefault();
      const evt: PasteCaptureEvent = {
        kind: "PASTE",
        fieldId,
        pastedLength: text.length, // length ONLY, never the text
        caretOffset: target.selectionStart ?? undefined,
        wasBlocked: true,
        at: now(),
      };
      clientRef.current?.enqueue(evt);
    },
    [active, cfg.toggles.pasteCapture, fieldId],
  );

  return useMemo(
    () => ({ active, pasteFriction, fieldProps: { onPaste, onKeyDown, onChange } }),
    [active, pasteFriction, onPaste, onKeyDown, onChange],
  );
}
