// =============================================================================
// An inbox is ordered by LAST ACTIVITY, not by when each thread was started
// =============================================================================
// `reply` bumps `messageThread.updatedAt` on every message — a write whose only
// purpose is to record recency — and `listThreads` ordered by `createdAt` and
// read it for nothing. So a conversation never moved: an inbox was a list of
// threads in the order they were OPENED, permanently.
//
// Measured on a teacher with 400 conversations, at 5,000-school scale: a parent
// replied at 06:15, and the teacher's page 1 showed threads whose last activity
// was 06:09-06:11 — all older — while the one carrying today's unread message
// sat at POSITION 400, four pages down. The busier the teacher, the deeper
// today's message is buried, which is exactly backwards.
//
// `createdAt` was not an oversight: an index existed for it and it is IMMUTABLE,
// so keyset paging over it can never skip or repeat. The cost of moving to a
// mutable sort key is real and is written down on `seekWhereOn`; the measured
// alternative was worse.
// =============================================================================

import { MessagingService } from "../../src/communication/messaging.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const me: Principal = { schoolId: "school-A", userId: "u-1", roles: ["teacher"], permissions: [] };

function makeService() {
  const calls: Array<Record<string, unknown>> = [];
  const tx = {
    messageThread: {
      findMany: jest.fn(async (args: Record<string, unknown>) => {
        calls.push(args);
        return [{ id: "t-1", subject: "T", createdAt: new Date("2020-01-01"), updatedAt: new Date() }];
      }),
    },
    threadParticipant: { findMany: jest.fn().mockResolvedValue([{ threadId: "t-1", lastReadAt: null }]) },
    message: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new MessagingService(db as never, { enqueue: jest.fn() } as never, { record: jest.fn() } as never);
  return { service, calls };
}

describe("the thread list", () => {
  it("orders by LAST ACTIVITY, so a reply raises its conversation", async () => {
    const { service, calls } = makeService();
    await service.listThreads(me, {});
    // The property: the newest ACTIVITY leads. Anchored to the order clause
    // rather than to any wording around it.
    expect(calls[0].orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
  });

  it("SEEKS on the same column it orders by — otherwise pages skip rows wholesale", async () => {
    // The subtle half. A cursor cut on `createdAt` against an `updatedAt`
    // ordering does not merely mis-sort: it seeks from a value the ordering
    // does not follow, and whole runs of threads are never returned at all.
    const { service, calls } = makeService();
    const cursor = `${new Date("2026-01-01T00:00:00.000Z").toISOString()}_11111111-1111-1111-1111-111111111111`;
    await service.listThreads(me, { cursor });
    const where = calls[0].where as { OR?: Array<Record<string, unknown>> };
    expect(where.OR).toBeDefined();
    for (const clause of where.OR ?? []) {
      expect(Object.keys(clause)).toContain("updatedAt");
      expect(Object.keys(clause)).not.toContain("createdAt");
    }
  });

  it("still bounds the read by the PAGE, not by the size of the inbox", async () => {
    // The property the previous fix established, kept: membership is a filter on
    // the relation, never a pre-fetch of the caller's participant rows.
    const { service, calls } = makeService();
    await service.listThreads(me, { limit: 25 });
    expect(calls[0].take).toBe(26); // limit + 1, the has-more probe
    expect(JSON.stringify(calls[0].where)).toContain("participants");
  });
});
