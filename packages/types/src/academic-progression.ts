// =============================================================================
// Academic progression — pure "what is the next term?" logic
// =============================================================================
// Shared by the manual "advance to next term" action and the automatic
// end-of-term sweep, so both pick the same next term. Deterministic and
// side-effect-free; the caller performs the actual isCurrent updates.
// =============================================================================

export interface ProgressionTerm {
  id: string;
  sessionId: string;
  sequence: number;
  isCurrent: boolean;
  endDate?: string | Date | null;
}
export interface ProgressionSession {
  id: string;
  /** Creation order — used to find the "next" session when a session ends. */
  createdAt: string | Date;
  startDate?: string | Date | null;
}

export interface NextTermTarget {
  termId: string;
  sessionId: string;
  /** True when advancing crosses into a NEW session (its first term). */
  newSession: boolean;
}

const ord = (v: string | Date): number => new Date(v).getTime();

/**
 * The term that follows the current one:
 *   1. the next term (by sequence) in the SAME session, else
 *   2. the FIRST term of the next session (ordered by startDate, then createdAt),
 *   3. or null when there is no further term (the calendar's final term).
 */
export function pickNextTerm(
  terms: ProgressionTerm[],
  sessions: ProgressionSession[],
  currentTermId?: string,
): NextTermTarget | null {
  const current = currentTermId
    ? terms.find((t) => t.id === currentTermId)
    : terms.find((t) => t.isCurrent);
  if (!current) return null;

  // 1. Next term in the same session.
  const nextInSession = terms
    .filter((t) => t.sessionId === current.sessionId && t.sequence > current.sequence)
    .sort((a, b) => a.sequence - b.sequence)[0];
  if (nextInSession) {
    return { termId: nextInSession.id, sessionId: current.sessionId, newSession: false };
  }

  // 2. First term of the next session.
  const currentSession = sessions.find((s) => s.id === current.sessionId);
  if (!currentSession) return null;
  // Pick the ordering key ONCE for the whole set: comparing one session's
  // startDate against another's createdAt is not a consistent order. Use
  // startDate only when EVERY session has one; otherwise fall back to
  // creation order for all of them.
  const allDated = sessions.every((s) => !!s.startDate);
  const key = (s: ProgressionSession): number => ord(allDated ? (s.startDate as string | Date) : s.createdAt);
  const nextSession = sessions
    .filter((s) => key(s) > key(currentSession))
    .sort((a, b) => key(a) - key(b))[0];
  if (!nextSession) return null;
  const firstTerm = terms
    .filter((t) => t.sessionId === nextSession.id)
    .sort((a, b) => a.sequence - b.sequence)[0];
  if (!firstTerm) return null;
  return { termId: firstTerm.id, sessionId: nextSession.id, newSession: true };
}

/** Has the current term's endDate passed `asOf`? (false when no endDate.) */
export function termHasElapsed(endDate: string | Date | null | undefined, asOf: Date): boolean {
  if (!endDate) return false;
  const end = new Date(endDate);
  end.setUTCHours(23, 59, 59, 999); // the whole end day is still "current"
  return asOf.getTime() > end.getTime();
}
