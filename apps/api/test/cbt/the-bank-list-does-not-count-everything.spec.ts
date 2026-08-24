// =============================================================================
// The bank list counted every question the school had ever written
// =============================================================================
// `listBanks` drew its question counts with
//
//     tx.cbtQuestion.groupBy({ by: ["bankId"], _count: { id: true } })
//
// — no `where` at all. Every load of the page aggregated the school's ENTIRE
// question table regardless of what was being shown, and nothing archives a
// question bank, so the cost grew with how long the school had been teaching
// rather than with anything on screen.
//
// Measured as the APPLICATION role with RLS in force (never as postgres, which
// bypasses row security and plans differently), on 200 banks holding 80,000
// questions — a busy secondary school's decade:
//
//   before  103.3 ms, 1,380 buffers   Seq Scan of all 80,000 + HashAggregate
//   after     3.6 ms,    59 buffers   Index Only Scan on (schoolId, bankId)
//
// TWO CHANGES, BOTH NEEDED, and it is worth knowing which does what:
//   * scoping to the listed banks is what lets the (schoolId, bankId) index be
//     used at all;
//   * `_count: true` counts ROWS rather than the `id` COLUMN, and that is what
//     makes it INDEX-ONLY — counting a column must visit the heap for every row
//     to read it. count(id) scoped was 9.3 ms; count(*) scoped is 3.6 ms.
//
// WHERE THE CEILING NOW IS, stated rather than implied. The list is deliberately
// NOT paginated: it feeds the bank PICKER, and paging a dropdown is a worse
// product than the problem it solves. Pushed to 800 banks and 320,000 questions
// — far past any real school, a bank every four days for a decade — the page
// costs 48 ms against 114 ms before. It is O(the school's banks) and not O(page),
// so it does degrade eventually; at a realistic 200 banks it is 3.6 ms, and it
// would need thousands of banks to be felt. That is a known limit, not an
// assumption, and this comment is where the next person finds the number.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CbtService } from "../../src/cbt/cbt.service";
import { CBT_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SRC = readFileSync(join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8");

function makeService(bankIds: string[]) {
  const groupBy = jest.fn().mockResolvedValue(bankIds.map((id) => ({ bankId: id, _count: 7 })));
  const tx = {
    cbtQuestionBank: {
      findMany: jest.fn().mockResolvedValue(
        bankIds.map((id) => ({ id, name: `Bank ${id}`, subject: "Physics", subjectId: "s1", createdAt: new Date() })),
      ),
    },
    cbtQuestion: { groupBy },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const svc = Object.create(CbtService.prototype) as CbtService;
  Object.assign(svc, {
    db: { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) },
    audit: { record: jest.fn() },
  });
  (svc as unknown as { ctx: unknown }).ctx = (p: Principal) => ({ schoolId: p.schoolId, userId: p.userId });
  return { svc, groupBy };
}

const PRINCIPAL: Principal = {
  schoolId: "A",
  userId: "p1",
  roles: ["principal"],
  permissions: [CBT_PERMISSIONS.CBT_MANAGE, CBT_PERMISSIONS.CBT_REVIEW],
};

describe("counting the questions in each bank", () => {
  it("asks only about the banks being shown", async () => {
    const t = makeService(["b1", "b2"]);
    await t.svc.listBanks(PRINCIPAL);
    expect(t.groupBy.mock.calls[0][0].where).toEqual({ bankId: { in: ["b1", "b2"] } });
  });

  it("counts ROWS, not a column — the difference between index-only and a heap visit", async () => {
    const t = makeService(["b1"]);
    await t.svc.listBanks(PRINCIPAL);
    expect(t.groupBy.mock.calls[0][0]._count).toBe(true);
  });

  it("reports each bank's own count", async () => {
    const t = makeService(["b1", "b2"]);
    const out = await t.svc.listBanks(PRINCIPAL);
    expect(out.map((b) => b.questionCount)).toEqual([7, 7]);
  });

  it("does not run an unfiltered IN () when a school has no banks yet", async () => {
    // `{ in: [] }` matches nothing, but asking at all is a query per page load
    // for the commonest state a new school is in.
    const t = makeService([]);
    await expect(t.svc.listBanks(PRINCIPAL)).resolves.toEqual([]);
    expect(t.groupBy).not.toHaveBeenCalled();
  });

  it("still shows zero for a bank with no questions", async () => {
    // The count map is keyed by bank; a bank absent from the aggregate must read
    // as 0 rather than undefined, or an empty bank renders blank.
    const t = makeService(["b1"]);
    (t.groupBy as jest.Mock).mockResolvedValue([]);
    const out = await t.svc.listBanks(PRINCIPAL);
    expect(out[0].questionCount).toBe(0);
  });
});

describe("the shape that made it slow", () => {
  it("is gone: no groupBy over the question table without a where", () => {
    // The regression guard. An unfiltered groupBy is the exact defect, and it
    // reads as perfectly ordinary code — which is why it survived this long.
    const listBanks = SRC.slice(SRC.indexOf("async listBanks"), SRC.indexOf("async createBank"));
    expect(listBanks).toMatch(/cbtQuestion\.groupBy\(\{[^}]*where:/);
  });
});
