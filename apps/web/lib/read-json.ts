/**
 * Reading a JSON body that may legitimately be ABSENT.
 *
 * Nest sends `null` from a handler as a **200 with a zero-byte body and no
 * content-type**. `res.json()` on that throws `SyntaxError: Unexpected end of
 * JSON input`, and in a React effect the throw lands mid-way through — so the
 * state set AFTER it never happens and the screen renders as though the fetch
 * had not returned at all.
 *
 * That is exactly how the attendance register form broke. `GET /classes/:id/
 * attendance?date=` answers `null` when nobody has taken that day's register —
 * the normal case, every morning — and the effect died on the parse before
 * `setRoster(students)`, so the class teacher saw the form with NO pupils and
 * NO save button. The class, the permission and the roster were all fine.
 *
 * The server-side reader already had this rule: `apiGet` in `lib/api.ts` ends
 * `const text = await res.text(); if (!text) return null;`. The client half was
 * never written, which is the sibling asymmetry this codebase keeps meeting —
 * so this is that same rule, for client components, written once.
 */
export async function readJson<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  const text = await res.text();
  // An empty body is an ANSWER ("there is no such thing"), not a failure.
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 carrying something that is not JSON is a fault, but a screen that
    // renders nothing is worse than one that renders what it does have.
    return null;
  }
}
