// Unit: the audit-log keyset cursor. audit_log is partitioned on createdAt, so
// its key is the COMPOSITE (id, createdAt) — the cursor token must carry both
// while staying opaque on the wire, and must degrade safely on a legacy token.

import { decodeAuditCursor, encodeAuditCursor } from "../../src/common/audit-cursor";

describe("audit cursor", () => {
  const id = "3f6c1a2e-0000-4000-8000-000000000001";
  const createdAt = new Date("2026-07-01T10:00:00.000Z");

  it("round-trips both halves of the composite key", () => {
    const decoded = decodeAuditCursor(encodeAuditCursor({ id, createdAt }));
    expect(decoded).toEqual({ id, createdAt });
  });

  it("keeps the uuid intact even though it contains no separator ambiguity", () => {
    // The uuid itself has hyphens, not underscores — split on the FIRST underscore.
    const token = encodeAuditCursor({ id, createdAt });
    expect(token).toBe(`2026-07-01T10:00:00.000Z_${id}`);
    expect(decodeAuditCursor(token)?.id).toBe(id);
  });

  it("returns null for a legacy bare-id token (pre-partitioning) — caller restarts", () => {
    expect(decodeAuditCursor(id)).toBeNull();
  });

  it("returns null for empty / malformed / bad-date tokens rather than throwing", () => {
    expect(decodeAuditCursor(undefined)).toBeNull();
    expect(decodeAuditCursor("")).toBeNull();
    expect(decodeAuditCursor("_abc")).toBeNull();
    expect(decodeAuditCursor("not-a-date_abc")).toBeNull();
    expect(decodeAuditCursor(`${createdAt.toISOString()}_`)).toBeNull();
  });
});
