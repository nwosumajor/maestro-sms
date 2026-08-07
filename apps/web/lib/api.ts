import "server-only";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/**
 * Server-side GET against the API, authenticated with a freshly-minted Bearer
 * from the session. Never cached — tenant-scoped, per-request data.
 *
 * WHAT NULL MEANS, AND WHAT THROWS:
 *
 *   no session        null   nothing to fetch with
 *   404 / empty body  null   the record genuinely is not there — this is the
 *                            case the function was written for (a pupil with no
 *                            medical record answers 200 with an empty body, and
 *                            res.json() would throw on that)
 *   401               null   the session is gone; middleware owns the redirect
 *   403               THROW  the page ALREADY decided you were allowed — every
 *                            one of these gates with `hasPermission` and
 *                            redirects otherwise — so a 403 means the web and
 *                            the API disagree about what you may do. Rendering
 *                            an empty list hides that: it is what made
 *                            head_teacher's missing `meeting.host` look like
 *                            "you have no meetings" instead of a broken role.
 *   5xx / network     THROW  the server is broken, so nothing we could render
 *                            is trustworthy
 *
 * The last line is the point. Callers overwhelmingly write `?? []` or `?? 0`,
 * which turned a failed request into a statement of fact — "No disputes", 
 * "Nothing waiting on you", "Approvals 0" — and a reader acts on those. A
 * throw unwinds to app/(app)/error.tsx, which says the page could not be
 * loaded and that this is NOT a report that there is nothing here.
 *
 * A caller that genuinely tolerates absence opts out EXPLICITLY with
 * `.catch(() => null)` — as AppShell does for branding and the renewal banner,
 * because a chrome widget must never take down the page it wraps. That is now
 * a deliberate statement rather than the silent default.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const token = await bearerForSession();
  if (!token) return null;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (cause) {
    // The API is unreachable. Rendering an empty page here would assert that
    // the school has no data, which is a different and much worse claim.
    throw new Error(`API unreachable: GET ${path}`, { cause });
  }
  // 5xx is the server telling us it failed. 4xx is an answer — except 403,
  // which is an answer that contradicts a decision this page already made.
  if (res.status >= 500) throw new Error(`API ${res.status}: GET ${path}`);
  if (res.status === 403) {
    throw new Error(
      `API 403: GET ${path} — the page allowed this user but the API refused. ` +
        `A role is probably missing a permission the endpoint requires.`,
    );
  }
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as T;
}
