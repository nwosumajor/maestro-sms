/**
 * The Learning Record Store is a RECORD, and it only ever showed the recent page.
 *
 * `xapi_statement` is append-only — the app role holds INSERT and SELECT and no
 * DELETE — and a statement is emitted automatically on every content completion
 * and quiz, so it grows with a class's whole history. The query returned the
 * most-recent 500 newest-first, with no filter, no paging and no total.
 *
 * Measured live on a class with 602 statements: the query reached back three and
 * a half weeks and the older 102 were unreachable by anything the product
 * offered, with nothing saying rows had been withheld. On the one table whose
 * entire purpose is to BE the queryable record.
 *
 * Fourth instance of the class here, after the chargeback banner, the admissions
 * queue and the review queues — and this one was NEVER SWEPT, because the sweep
 * that found the others was scoped to "the 128 tables the app role cannot DELETE
 * from" and that count had since grown to 153.
 */
import { LmsContentService } from "../../src/lms/lms-content.service";

function makeService(rowCount: number) {
  const findMany = jest.fn().mockImplementation((a: { skip?: number; take?: number }) => {
    const start = a.skip ?? 0;
    const take = a.take ?? rowCount;
    return Array.from({ length: Math.max(0, Math.min(take, rowCount - start)) }, (_, i) => ({
      id: `s-${start + i}`, actorId: "stu-1", verb: "completed",
      objectId: "o", objectName: "Activity", classId: "cls-1",
      result: {}, storedAt: new Date(2026, 0, 1 + start + i),
    }));
  });
  const count = jest.fn().mockResolvedValue(rowCount);
  const tx = { xapiStatement: { findMany, count }, user: { findMany: jest.fn().mockResolvedValue([]) } };
  const svc = Object.create(LmsContentService.prototype) as LmsContentService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    ctx: () => ({ schoolId: "sch-1", userId: "stu-1" }),
    canAuthor: jest.fn().mockResolvedValue(true),
    nameMap: jest.fn().mockResolvedValue(new Map()),
  });
  return { svc, findMany, count };
}

const P = { schoolId: "sch-1", userId: "stu-1" } as never;
const list = (svc: LmsContentService, q: Record<string, unknown>) =>
  (svc as unknown as { listStatements: (p: unknown, q: unknown) => Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> })
    .listStatements(P, q);

describe("a record store that only kept the recent page", () => {
  it("reports the TOTAL, so a reader can tell a page from everything", async () => {
    const { svc } = makeService(602);
    const res = await list(svc, { classId: "cls-1" });
    expect(res.total).toBe(602);
    expect(res.items.length).toBe(res.pageSize);
    expect(res.items.length).toBeLessThan(res.total);
  });

  it("reaches the older records by page", async () => {
    const { svc, findMany } = makeService(602);
    await list(svc, { classId: "cls-1", page: 3 });
    expect(findMany.mock.calls[0][0].skip).toBe(2 * 50);
  });

  it("windows by date, which is how an LRS is actually queried", async () => {
    const { svc, findMany } = makeService(602);
    const from = new Date("2026-07-01");
    const to = new Date("2026-07-31");
    await list(svc, { classId: "cls-1", from, to });
    expect(findMany.mock.calls[0][0].where.storedAt).toEqual({ gte: from, lte: to });
  });

  it("counts the SAME filter it lists, never the whole store", async () => {
    // A total that ignores the filter is a number the page cannot act on.
    const { svc, count, findMany } = makeService(602);
    await list(svc, { classId: "cls-1", from: new Date("2026-07-01") });
    expect(count.mock.calls[0][0].where).toEqual(findMany.mock.calls[0][0].where);
  });

  it("orders newest-first with a tiebreak, so paging cannot repeat a row", async () => {
    // Same instant on two statements would otherwise let a row appear on two
    // pages and another on none.
    const { svc, findMany } = makeService(10);
    await list(svc, { classId: "cls-1" });
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ storedAt: "desc" }, { id: "desc" }]);
  });

  it("still scopes a non-staff caller to their own record", async () => {
    // Magnitude: paging must not have widened who sees what.
    const { svc, findMany } = makeService(10);
    (svc as unknown as { canAuthor: jest.Mock }).canAuthor = jest.fn().mockResolvedValue(false);
    await list(svc, { classId: "cls-1" });
    expect(findMany.mock.calls[0][0].where.actorId).toBe("stu-1");
  });
});
