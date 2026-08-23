import "server-only";
import { bearerForSession } from "@/lib/apiToken";
import { redirect } from "next/navigation";
import { SCHOOL_SUSPENDED_CODE } from "@sms/types";

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
 *   403               null   + a server-side warning. See the note below: this
 *                            was briefly a throw, and that was wrong.
 *   429               THROW  the server DECLINED to answer. The per-tenant
 *                            limiter allows 1,200 req/min per SCHOOL, and a
 *                            rejected request rendered as "No invoices" — a
 *                            busy school being told its ledger is empty. This
 *                            is not an answer about the data at all.
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
 *
 * WHY 403 IS *NOT* A THROW, HAVING BRIEFLY BEEN ONE
 * -------------------------------------------------
 * A 403 was made to throw on the reasoning that every page gates with
 * hasPermission first, so a refusal must mean the web and the API disagree.
 * That premise is false here: measured against a real stack, 52 of 102 routes
 * across 18 roles — 491 (page, role) pairs, 27% of all renders — fetch
 * something the caller may not read and rely on this function returning null.
 * Making it throw turned half the app into an error screen for most roles.
 *
 * It shipped because the route smoke could not see it. The smoke passed all
 * 1,734 renders twice: an SSR throw is served as a 200 whose error boundary is
 * a CLIENT component, so no error text appears in the HTML; and the run was
 * saturating the per-tenant rate limiter (19,286 429s), which this function
 * ALSO rendered as an empty page. Both are fixed — the smoke now reads the
 * flight-stream digest, and a 429 throws.
 *
 * The drift a throw was meant to catch is real, so it is not discarded: a 403
 * is logged server-side with the path. That surfaces in the API/Sentry logs
 * without telling a parent their invoices do not exist.
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
  // which contradicts a decision this page already made, and 429, which is the
  // server declining to answer at all.
  if (res.status >= 500) throw new Error(`API ${res.status}: GET ${path}`);
  if (res.status === 429) {
    throw new Error(
      `API 429: GET ${path} — rate limited, so this is not an answer about the ` +
        `data. Rendering it as empty would tell a busy school it has none.`,
    );
  }
  if (res.status === 403) {
    // A SUSPENDED SCHOOL IS NOT A MISSING PERMISSION.
    //
    // An ordinary 403 means this reader is not entitled to this endpoint, and
    // `null` is the right answer — half the app's pages read something their
    // caller may lack. But when the platform has switched the school off, EVERY
    // read returns 403, so `null` everywhere renders a whole app of empty panels
    // and tells the user nothing at all. The API tags that case; send them to a
    // page that says what happened.
    // Read directly, not through clone(): this branch always returns, so the
    // body is never needed again — and clone() is one more thing a caller's test
    // double has to implement for no benefit.
    const body = await res.text().catch(() => "");
    if (body.includes(SCHOOL_SUSPENDED_CODE)) redirect("/suspended");
    // Logged, not thrown. Throwing here broke 491 (page, role) pairs. A page
    // that KNOWS its readers may lack a permission should still gate the call —
    // `can ? apiGet(...) : null` — so this line stays quiet.
    console.warn(`api: 403 GET ${path} — caller lacks the endpoint's permission`);
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as T;
}
