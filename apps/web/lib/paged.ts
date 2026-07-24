"use client";

// =============================================================================
// usePaged — client half of the API's keyset pagination
// =============================================================================
// The list endpoints return `{ items, nextCursor }` and cap a page at a bounded
// size, so a school with thousands of tasks/polls/posts no longer ships its whole
// history in one response. This hook holds the accumulated pages and fetches the
// next one through the BFF on demand.
//
// The first page is rendered on the server and arrives as props; a `router.refresh()`
// after any mutation replaces it, which deliberately RESETS the accumulation back
// to page one — the refreshed first page is the authoritative newest state, and
// stitching stale later pages onto it would show a torn list.
// =============================================================================

import * as React from "react";

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export function usePaged<T>(page: Paged<T>, path: string) {
  const [extra, setExtra] = React.useState<T[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(page.nextCursor);
  const [loading, setLoading] = React.useState(false);

  // Re-seed whenever the server hands down a fresh first page.
  const firstItems = page.items;
  const firstCursor = page.nextCursor;
  React.useEffect(() => {
    setExtra([]);
    setCursor(firstCursor);
  }, [firstItems, firstCursor]);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`/api/sms/${path}${sep}cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Paged<T>;
      setExtra((prev) => [...prev, ...(next.items ?? [])]);
      setCursor(next.nextCursor ?? null);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, path]);

  return { items: [...firstItems, ...extra], hasMore: cursor !== null, loading, loadMore };
}
