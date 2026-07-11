// =============================================================================
// xAPI (Tin Can) helpers (pure)
// =============================================================================
// The LRS accepts an allow-listed set of verbs and a bounded result object.
// Keeping this pure + validated at the boundary means a caller can't store an
// arbitrary verb or an oversized/garbage result. The actor is NEVER taken from
// here — it comes from the verified JWT in the service.
// =============================================================================

import type { XapiResult, XapiVerb } from "@sms/types";

const VERBS = new Set<string>([
  "experienced",
  "completed",
  "passed",
  "failed",
  "attempted",
  "answered",
  "progressed",
]);

export function isXapiVerb(v: unknown): v is XapiVerb {
  return typeof v === "string" && VERBS.has(v);
}

/** Normalise an xAPI result: coerce/bound the numeric score+max, keep only the
 *  recognised boolean flags, and cap the free-text response. Returns a clean
 *  object safe to persist (never throws). */
export function normalizeXapiResult(input: unknown): XapiResult {
  const r = (input ?? {}) as Record<string, unknown>;
  const out: XapiResult = {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const score = num(r.score);
  const max = num(r.max);
  if (score !== undefined) out.score = score;
  if (max !== undefined && max > 0) out.max = max;
  if (typeof r.success === "boolean") out.success = r.success;
  if (typeof r.completion === "boolean") out.completion = r.completion;
  if (typeof r.response === "string" && r.response.trim()) out.response = r.response.trim().slice(0, 1000);
  return out;
}
