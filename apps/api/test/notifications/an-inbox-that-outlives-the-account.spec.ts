// =============================================================================
// The owner's inbox in year ten
// =============================================================================
// The platform owner is the recipient of every operator alert, dunning digest,
// dispute warning, referral conversion and onboarding request the platform
// raises. Their inbox is not a queue that drains — it is where "did anyone get
// told about that", "when did that school lapse" and "what did the sweep say in
// March" are answered, months later.
//
// It showed the most recent hundred and said nothing about the rest. No filter,
// no page, no total. Measured with 500,000 notifications on that one account:
//
//   list (100 newest)     Parallel Seq Scan, 500,000 rows, 11,654 buffers, 63 ms
//   with the new index    Index Scan, 18 buffers, 0.23 ms
//   count(*) total        27 ms   — index-only, but every row, every page load
//   count(*) by type      42 ms   — seq scan
//   count(*) rare search  135 ms  — seq scan
//
// So the index fixes the page, and the COUNTS were left scaling with how long
// the account has existed. Hence the cap: a count stops looking after
// NOTIFICATION_COUNT_CAP and says so, because "showing 50 of 1,000+" is as
// useful to read as "of 47,213" and costs a fixed amount to produce.
//
// Paging is deliberately NOT limited by that cap — `hasMore` comes from
// fetching one row past the page — or the cap would become a new wall in front
// of the same records.
// =============================================================================

import { NotificationService } from "../../src/notifications/notification.service";
import { NOTIFICATION_COUNT_CAP, NOTIFICATION_PAGE_SIZE } from "../../src/notifications/notification.constants";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

/** An inbox of `size` rows; the stub honours skip/take/where like the database. */
function makeService(size: number, unread = 0) {
  const rows = Array.from({ length: size }, (_, i) => ({
    id: `n${i}`,
    type: i % 3 === 0 ? "OPERATOR_ALERT" : "GENERIC",
    title: `Alert ${i}`,
    body: "x",
    readAt: i < unread ? null : new Date(),
    createdAt: new Date(Date.now() - i * 1000),
  }));
  const matching = (where: Record<string, unknown>) =>
    rows
      .filter((r) => (where.readAt === null ? r.readAt === null : true))
      .filter((r) => (where.type ? r.type === where.type : true));
  const findMany = jest.fn(
    ({ where, skip = 0, take }: { where: Record<string, unknown>; skip?: number; take?: number }) =>
      Promise.resolve(matching(where).slice(skip, take === undefined ? undefined : skip + take)),
  );
  const tx = { notification: { findMany } } as unknown as TenantTx;
  const svc = Object.create(NotificationService.prototype) as NotificationService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
  });
  return { svc, findMany };
}

const owner: Principal = {
  schoolId: "PLATFORM",
  userId: "owner",
  roles: ["super_admin"],
  permissions: ["notification.read"],
};

describe("a page of the inbox", () => {
  it("returns one page, not the whole account", async () => {
    const { svc } = makeService(5000);
    const r = await svc.listMine(owner, {});
    expect(r.items).toHaveLength(NOTIFICATION_PAGE_SIZE);
    expect(r.pageSize).toBe(NOTIFICATION_PAGE_SIZE);
  });

  it("says there is more without counting it", async () => {
    const { svc } = makeService(5000);
    const r = await svc.listMine(owner, {});
    expect(r.hasMore).toBe(true);
  });

  it("says there is NOT more when the page is the end", async () => {
    // Fetching one past the page is the whole mechanism; if it were `>=` rather
    // than `>`, every last page would offer an empty next one.
    const { svc } = makeService(NOTIFICATION_PAGE_SIZE);
    const r = await svc.listMine(owner, {});
    expect(r.hasMore).toBe(false);
    expect(r.items).toHaveLength(NOTIFICATION_PAGE_SIZE);
  });

  it("reaches the older pages", async () => {
    const { svc } = makeService(5000);
    const p2 = await svc.listMine(owner, { page: 2 });
    expect(p2.page).toBe(2);
    expect(p2.items[0].id).toBe(`n${NOTIFICATION_PAGE_SIZE}`);
  });

  it("pages past the count's cap", async () => {
    // The cap bounds the COUNT, and must not become a wall in front of the
    // records — page 40 of 50 is well beyond 1,000 rows counted.
    const { svc } = makeService(5000);
    const deep = await svc.listMine(owner, { page: 40 });
    expect(deep.items).toHaveLength(NOTIFICATION_PAGE_SIZE);
    expect(deep.hasMore).toBe(true);
  });
});

describe("what the counts cost", () => {
  it("stops counting at the cap and says so", async () => {
    const { svc } = makeService(5000);
    const r = await svc.listMine(owner, {});
    expect(r.total).toBe(NOTIFICATION_COUNT_CAP);
    expect(r.totalIsCapped).toBe(true);
  });

  it("reports the real total when it is under the cap", async () => {
    const { svc } = makeService(120);
    const r = await svc.listMine(owner, {});
    expect(r.total).toBe(120);
    expect(r.totalIsCapped).toBe(false);
  });

  it("never asks the database for more than the cap", async () => {
    // The point of the cap is bounded WORK. A count that read everything and
    // then trimmed the answer would report the same number and fix nothing.
    const { svc, findMany } = makeService(50_000);
    await svc.listMine(owner, {});
    for (const call of findMany.mock.calls) {
      expect(call[0].take).toBeLessThanOrEqual(NOTIFICATION_COUNT_CAP);
    }
  });

  it("caps the unread badge the same way, for the same reason", async () => {
    const { svc } = makeService(50_000, 50_000);
    const r = await svc.listMine(owner, {});
    expect(r.unread).toBe(NOTIFICATION_COUNT_CAP);
    expect(r.unreadIsCapped).toBe(true);
  });

  it("counts ALL unread, even while a filter is applied", async () => {
    // The badge tells somebody to come back to this screen. Scoped to the
    // current filter it would read "0 unread" while forty unread alerts sat one
    // dropdown away — and a filter is the state this page is usually left in.
    //
    // Asserted UNDER a filter on purpose: with no filter the global count and
    // the filtered count are the same number, so the test would pass either way.
    const { svc } = makeService(500, 200);
    const r = await svc.listMine(owner, { type: "OPERATOR_ALERT" });
    expect(r.unread).toBe(200);
    expect(r.total).not.toBe(200);
  });
});

describe("filtering", () => {
  it("filters the whole inbox, not the page", async () => {
    // Narrowing the loaded page would mean "operator alerts among the last
    // fifty arrivals" and quietly answer a different question.
    const { svc, findMany } = makeService(5000);
    await svc.listMine(owner, { type: "OPERATOR_ALERT" });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ type: "OPERATOR_ALERT" });
  });

  it("counts what MATCHES the filter, not the whole inbox", async () => {
    const { svc } = makeService(300);
    const r = await svc.listMine(owner, { type: "OPERATOR_ALERT" });
    expect(r.total).toBe(100); // every third row
  });

  it("searches title and body together", async () => {
    const { svc, findMany } = makeService(10);
    await svc.listMine(owner, { q: "dispute" });
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { title: { contains: "dispute", mode: "insensitive" } },
      { body: { contains: "dispute", mode: "insensitive" } },
    ]);
  });

  it("ignores a blank search rather than matching everything oddly", async () => {
    const { svc, findMany } = makeService(10);
    await svc.listMine(owner, { q: "   " });
    expect(findMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it("always scopes to the caller, whatever else is asked for", async () => {
    // SECURITY: every filter ANDs onto the recipient scope; none replaces it.
    const { svc, findMany } = makeService(10);
    await svc.listMine(owner, { type: "OPERATOR_ALERT", q: "x", unreadOnly: true });
    for (const call of findMany.mock.calls) {
      expect(call[0].where.recipientId).toBe("owner");
    }
  });
});
