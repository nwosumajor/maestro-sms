import "server-only";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/**
 * Server-side GET against the API, authenticated with a freshly-minted Bearer
 * from the session. Returns null on no-session or non-2xx (callers render an
 * empty/again state). Never cached — tenant-scoped, per-request data.
 *
 * An endpoint may legitimately answer 200 with an EMPTY body (e.g. a student
 * with no medical record) — `res.json()` throws on that, so read the text first
 * and treat an empty body as null rather than crashing the whole SSR render.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const token = await bearerForSession();
  if (!token) return null;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as T;
}
