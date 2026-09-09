// =============================================================================
// interpretApiError — one place that turns an API failure into a sentence a
// school user can act on. Every mutation helper (postSms/sendSms, step-up
// senders, admin forms) routes its error text through here, so a bare
// "Failed (403)" never reaches the screen.
// =============================================================================

/** What each status MEANS for the person clicking the button. */
const INTERPRETATION: Record<number, string> = {
  400: "The input wasn't valid — check the fields and try again.",
  401: "Your session has expired — please sign in again.",
  403: "You don't have permission for this action, or it needs a fresh password confirmation (step-up).",
  404: "Not found in your school — it may have been removed, or it belongs to a module your plan doesn't include.",
  409: "This conflicts with existing data.",
  429: "Too many attempts — wait a minute, then try again.",
  500: "Something went wrong on the server — try again; if it keeps happening, contact your administrator.",
  503: "This feature isn't configured on this deployment yet — ask your administrator.",
};

/**
 * Combine the server's own message (already specific, e.g. the 409 guards
 * explain exactly what blocks a delete) with the status interpretation.
 * The server detail leads; the interpretation is appended only when it adds
 * something the detail doesn't already say.
 */
/**
 * Nest's DEFAULT reason phrases. They carry no information the status has not
 * already given, and gluing one to the front produces "Forbidden — You don't
 * have permission for this action", which reads like two sentences from two
 * different people. Treated as no detail at all.
 */
const GENERIC_DETAIL = new Set([
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "conflict",
  "internal server error",
  "service unavailable",
  "too many requests",
  "unprocessable entity",
]);

/**
 * @param fallback a caller's own hint, used ONLY when the server gave no
 *   specific reason. It must never REPLACE the server's message: a status often
 *   has several causes and the component knows one of them.
 *
 *   Measured on `POST /payments/:id/approve`, where the UI asserted "You can't
 *   approve a payment you recorded" for every 403: the recorder gets exactly
 *   that from the API, and somebody merely lacking `fee.approve` gets
 *   "Forbidden" — and was told they had recorded a payment they had never seen.
 */
export function interpretApiError(status: number, serverMessage?: string | null, fallback?: string): string {
  const raw = serverMessage?.trim();
  const detail = raw && !GENERIC_DETAIL.has(raw.toLowerCase()) ? raw : undefined;
  const why = INTERPRETATION[status] ?? `The request failed (HTTP ${status}).`;
  // A SPECIFIC server message IS the explanation. Appending the generic clause
  // can flatly contradict it — "You cannot approve a payment you recorded" is
  // not a permission problem, and telling someone it might be sends them to ask
  // for access they already have.
  if (detail) return detail;
  if (fallback?.trim()) return fallback.trim();
  return why;
}

/**
 * Read a failed Response and turn it into one actionable sentence — the shared
 * reader for mutation helpers that hand back a raw `Response` (e.g. the step-up
 * senders). Pulls the server's own `message` (string or string[]) and routes it
 * through interpretApiError, so no caller re-implements body parsing or leaks a
 * bare "Failed (403)".
 */
export async function readApiError(res: Response, fallback?: string): Promise<string> {
  let serverMessage: string | null = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { message?: string | string[] };
      serverMessage = Array.isArray(parsed.message) ? parsed.message.join(", ") : parsed.message ?? null;
    } catch {
      serverMessage = text;
    }
  }
  return interpretApiError(res.status, serverMessage, fallback);
}
