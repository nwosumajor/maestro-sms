import "server-only";
import { bearerForSession } from "@/lib/apiToken";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";

/**
 * Server-side GET against the API, authenticated with a freshly-minted Bearer
 * from the session. Returns null on no-session or non-2xx (callers render an
 * empty/again state). Never cached — tenant-scoped, per-request data.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const token = await bearerForSession();
  if (!token) return null;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}
