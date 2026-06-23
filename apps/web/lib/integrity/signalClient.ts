// =============================================================================
// Assessment Integrity — client-side signal transport
// =============================================================================
// Best-effort, batched POST of client signals to the API.
//
// DESIGN INVARIANTS (CLAUDE.md "Client-side"):
//  - This is SIGNAL COLLECTION, never enforcement. The student's ability to do
//    their work must NEVER depend on these calls succeeding. Every failure is
//    swallowed — the worst case is a missing signal, which is acceptable because
//    client telemetry is "trivially bypassable" and treated as a hint only.
//  - On page hide / unload we fall back to navigator.sendBeacon so a final
//    flush survives navigation. Beacon failures are likewise ignored.
// =============================================================================

import type { ClientSignal, ClientSignalBatch } from "@sms/types/integrity";

export interface SignalClientOptions {
  apiBaseUrl: string;
  assessmentId: string;
  submissionId: string;
  /** Max buffered signals before an automatic flush. */
  flushThreshold?: number;
  /** Idle flush interval (ms). */
  flushIntervalMs?: number;
}

const ENDPOINT = (base: string, assessmentId: string, submissionId: string) =>
  `${base.replace(/\/$/, "")}/assessments/${assessmentId}/submissions/${submissionId}/signals`;

export class IntegritySignalClient {
  private readonly url: string;
  private readonly assessmentId: string;
  private readonly submissionId: string;
  private readonly flushThreshold: number;
  private buffer: ClientSignal[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SignalClientOptions) {
    this.assessmentId = opts.assessmentId;
    this.submissionId = opts.submissionId;
    this.url = ENDPOINT(opts.apiBaseUrl, opts.assessmentId, opts.submissionId);
    this.flushThreshold = opts.flushThreshold ?? 20;
    const intervalMs = opts.flushIntervalMs ?? 15_000;
    if (typeof window !== "undefined") {
      this.timer = setInterval(() => void this.flush(), intervalMs);
    }
  }

  /** Queue a signal; auto-flush when the buffer fills. */
  enqueue(signal: ClientSignal): void {
    this.buffer.push(signal);
    if (this.buffer.length >= this.flushThreshold) void this.flush();
  }

  /** Send buffered signals. Uses fetch normally, beacon when `final`. */
  async flush(final = false): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch: ClientSignalBatch = {
      assessmentId: this.assessmentId,
      submissionId: this.submissionId,
      signals: this.buffer.splice(0, this.buffer.length),
    };
    try {
      const body = JSON.stringify(batch);
      if (final && typeof navigator !== "undefined" && navigator.sendBeacon) {
        // Beacon carries cookies for Auth.js session; survives unload.
        navigator.sendBeacon(this.url, new Blob([body], { type: "application/json" }));
        return;
      }
      await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "include",
        keepalive: final,
      });
    } catch {
      // SECURITY/UX: never surface or rethrow. A lost signal must not interrupt
      // the student. Dropped on purpose rather than retried indefinitely.
    }
  }

  /** Stop timers and do a final beacon flush. Call on unmount. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.flush(true);
  }
}
