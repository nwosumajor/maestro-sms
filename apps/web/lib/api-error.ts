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
export function interpretApiError(status: number, serverMessage?: string | null): string {
  const detail = serverMessage?.trim();
  const why = INTERPRETATION[status] ?? `The request failed (HTTP ${status}).`;
  // 400/409 server messages are the full explanation; don't drown them.
  if (detail && (status === 400 || status === 409)) return detail;
  if (detail) return `${detail} — ${why}`;
  return why;
}
