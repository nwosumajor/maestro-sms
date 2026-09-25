// =============================================================================
// A dashboard card's read, as one of three things that are TRUE
// =============================================================================
// `apiGet` returns null for an answer that holds nothing for this reader (a 403
// or 404) and THROWS when the API failed to answer (5xx, 429, unreachable). A
// page that awaits several cards together therefore loses ALL of them to one
// failing read: the error boundary replaces the whole page. And a card handed a
// bare `null` cannot tell "nothing for you" from "could not ask", so it guessed
// — both platform-dashboard cards said "the privileged database connection is
// not configured", a cause they could not know, shown for a 403 or 404, never
// for the unconfigured case (that is a 503, which threw).
//
// So each card's read is caught ON ITS OWN and handed over as a state, and the
// card says only what is known: nothing for this account, or the server failed
// to answer (with the status when there was one).
// =============================================================================

export type CardRead<T> =
  | { state: "ok"; data: T }
  | { state: "unavailable" }
  | { state: "failed"; status: number | null };

export async function readForCard<T>(read: Promise<T | null>): Promise<CardRead<T>> {
  try {
    const data = await read;
    return data === null ? { state: "unavailable" } : { state: "ok", data };
  } catch (e) {
    // `apiGet` names the status in its message ("API 503: GET …"); an
    // unreachable API has none.
    const m = /\bAPI (\d{3})\b/.exec((e as Error)?.message ?? "");
    return { state: "failed", status: m ? Number(m[1]) : null };
  }
}
