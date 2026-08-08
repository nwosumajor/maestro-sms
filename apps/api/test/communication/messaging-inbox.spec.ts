// =============================================================================
// MessagingService.listThreads / searchMessages — membership is a JOIN
// =============================================================================
// Both used to PRE-FETCH the caller's participant rows with `take: 2000` and no
// orderBy, then work within whatever came back. Anyone in more than 2,000
// threads had the rest made permanently invisible, and the ones dropped were
// arbitrary rather than oldest: measured on a 2,600-thread inbox, paging to the
// very end returned exactly 2,000 and the 600 missing were scattered — the
// 14th-newest conversation among them — with nothing in the response saying so.
//
// These cases pin the SHAPE, because that is what a future edit would undo. A
// test asserting only "returns some threads" passes just as happily against the
// broken version.
// =============================================================================

import { MessagingService } from "../../src/communication/messaging.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const me: Principal = { schoolId: "school-A", userId: "u-1", roles: ["school_admin"], permissions: [] };

function makeService(threadCount = 3) {
  const threads = Array.from({ length: threadCount }, (_, i) => ({
    id: `t-${i}`, subject: `Thread ${i}`, createdAt: new Date(), updatedAt: new Date(),
  }));
  const threadFindMany = jest.fn().mockResolvedValue(threads);
  const participantFindMany = jest.fn().mockResolvedValue(
    threads.map((t) => ({ threadId: t.id, lastReadAt: null })),
  );
  const queryRaw = jest.fn().mockResolvedValue([]);
  const tx = {
    messageThread: { findMany: threadFindMany },
    threadParticipant: { findMany: participantFindMany },
    message: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: queryRaw,
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new MessagingService(db as never, { enqueue: jest.fn() } as never);
  return { service, threadFindMany, participantFindMany, queryRaw };
}

describe("MessagingService inbox reachability", () => {
  it("filters threads BY MEMBERSHIP and takes only a page", async () => {
    const { service, threadFindMany } = makeService();
    await service.listThreads(me, { limit: 50 });
    const arg = threadFindMany.mock.calls[0][0] as {
      where: { participants?: { some: { userId: string } }; id?: unknown };
      take: number;
    };
    // The membership is a relation filter Postgres resolves...
    expect(arg.where.participants).toEqual({ some: { userId: "u-1" } });
    // ...NOT a pre-computed list of ids, which is what the cap truncated.
    expect(arg.where.id).toBeUndefined();
    expect(arg.take).toBeLessThanOrEqual(51);
  });

  it("never reads the caller's participant rows unbounded", async () => {
    const { service, participantFindMany } = makeService();
    await service.listThreads(me, { limit: 50 });
    // Participants are still read — for lastReadAt — but ONLY for the page.
    for (const call of participantFindMany.mock.calls) {
      const where = call[0].where as { threadId?: { in: string[] } };
      expect(where.threadId?.in).toBeDefined();
      expect(call[0].take).toBeUndefined(); // no cap, because it is already narrow
    }
  });

  it("search joins the membership instead of pre-filtering thread ids", async () => {
    const { service, queryRaw, participantFindMany } = makeService();
    await service.searchMessages(me, "attendance");
    expect(participantFindMany).not.toHaveBeenCalled();
    const sql = (queryRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toMatch(/JOIN\s+"thread_participant"/i);
    expect(sql).toMatch(/LIMIT/i);
  });

  it("a query under two characters searches nothing at all", async () => {
    const { service, queryRaw } = makeService();
    await expect(service.searchMessages(me, "a")).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
