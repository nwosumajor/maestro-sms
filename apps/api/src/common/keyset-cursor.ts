// =============================================================================
// Keyset (seek) pagination — the shared cursor for busy list endpoints
// =============================================================================
// OFFSET pagination degrades linearly: `OFFSET 10000` makes Postgres walk and
// discard 10 000 rows on every page. Keyset seeks straight to the row after the
// cursor using the SAME (createdAt DESC, id DESC) index the list already sorts
// by, so page 500 costs what page 1 costs.
//
// The token is OPAQUE to clients: "<createdAt ISO>_<uuid>". A malformed or
// missing token decodes to null and is treated as "first page" rather than an
// error, so a stale bookmark degrades gracefully instead of 400-ing.
//
// `id` is the tiebreaker — createdAt alone is not unique, and without it rows
// sharing a timestamp would be skipped or repeated across a page boundary.
// =============================================================================

export interface KeysetCursor {
  id: string;
  createdAt: Date;
}

/** A page of rows plus the token that fetches the next one (null when done). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(row: { id: string; createdAt: Date }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

export function decodeCursor(token: string | undefined | null): KeysetCursor | null {
  if (!token) return null;
  const sep = token.indexOf("_");
  if (sep <= 0) return null;
  const createdAt = new Date(token.slice(0, sep));
  const id = token.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { id, createdAt };
}

/** Clamp a caller-supplied page size into a sane, non-abusive range. */
export function pageLimit(requested: number | undefined, fallback = 50, max = 100): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * The `where` fragment that seeks past the cursor on a (createdAt DESC, id DESC)
 * ordering: strictly older rows, plus same-instant rows with a smaller id.
 * Returns `{}` for the first page.
 */
export function seekWhere(cursor: KeysetCursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * Turn `limit + 1` fetched rows into a page: trim the probe row and emit a
 * cursor only when there genuinely is another page (so clients stop cleanly).
 */
export function toPage<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null };
}
