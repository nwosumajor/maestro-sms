// =============================================================================
// Audit-log keyset cursor (scaling Phase 5)
// =============================================================================
// audit_log is RANGE-partitioned by month, and Postgres requires the partition
// key in every unique constraint — so its key is (id, createdAt) and a Prisma
// `cursor` must name BOTH fields. The wire contract is unchanged: `nextCursor`
// stays an OPAQUE string, it simply now encodes both halves of the key.
//
// Format: "<createdAt ISO>_<uuid>". A malformed/legacy token (a bare uuid issued
// before partitioning) decodes to null and is treated as "no cursor" — the caller
// restarts from the first page rather than erroring.
// =============================================================================

export interface AuditCursor {
  id: string;
  createdAt: Date;
}

export function encodeAuditCursor(row: { id: string; createdAt: Date }): string {
  return `${row.createdAt.toISOString()}_${row.id}`;
}

export function decodeAuditCursor(token: string | undefined | null): AuditCursor | null {
  if (!token) return null;
  const sep = token.indexOf("_");
  if (sep <= 0) return null;
  const createdAt = new Date(token.slice(0, sep));
  const id = token.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { id, createdAt };
}
