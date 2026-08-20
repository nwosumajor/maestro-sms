// =============================================================================
// A maker-checker record you could not look up
// =============================================================================
// The approvals register answered "who raised this, who approved it, and when"
// properly — GET /workflows/:id returns the initiator, every stage's approver
// and timestamp, whether a stage was decided under a temporary elevation, and
// the immutable trail. The problem was FINDING the request to ask about.
//
// The list returned the 500 most recent, unfiltered and unpaged, because the
// cap's own note says inbox views "only ever surface the most-recent page".
// True of a queue of live work. This list is also how a school reads its
// maker-checker record, and that grows forever.
//
// Measured against the running stack with 702 requests:
//
//     returned          500
//     oldest reachable  three weeks old
//     page HTML         718 KB in one response
//
// Everything older existed in the database and could not be reached by any
// means the product offered — no filter, no search, no date range, no page 2.
// A school asked "who approved that fee schedule in March" and the answer was
// unavailable, which for an audit record is most of the way to not having one.
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import { WORKFLOW_PAGE_SIZE, LIST_CAP, STAFF_REQUEST_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(rows: Array<Record<string, unknown>>) {
  const findMany = jest.fn().mockImplementation(({ skip = 0, take = rows.length }) =>
    Promise.resolve(rows.slice(skip, skip + take)),
  );
  const count = jest.fn().mockResolvedValue(rows.length);
  const tx = {
    workflowRequest: { findMany, count },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  return {
    service: new WorkflowService(db as never, {} as never, {} as never),
    findMany,
    count,
    where: () => findMany.mock.calls[0][0].where as Record<string, unknown>,
  };
}

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `w${i}`,
  type: "LEAVE",
  title: `Leave: Annual ${i}`,
  state: "APPROVED",
  initiatorId: "staff",
  createdAt: new Date(),
  currentStage: 0,
  stageCount: 0,
  stages: [],
  approvals: [],
  payload: {},
  ...over,
});

const reviewer: Principal = {
  schoolId: "A",
  userId: "me",
  roles: [],
  permissions: [WORKFLOW_PERMISSIONS.READ, WORKFLOW_PERMISSIONS.REVIEW, WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL],
};

describe("reaching a request that is not recent", () => {
  it("returns a PAGE, and says how many match", async () => {
    // Without `total` a truncated list reads as the complete answer.
    const { service } = makeService(Array.from({ length: 702 }, (_, i) => row(i)));
    const res = await service.listRequests(reviewer, {});
    expect(res.items).toHaveLength(WORKFLOW_PAGE_SIZE);
    expect(res.total).toBe(702);
    expect(res.page).toBe(1);
  });

  it("pages into history rather than stopping at the most recent", async () => {
    const { service, findMany } = makeService(Array.from({ length: 702 }, (_, i) => row(i)));
    await service.listRequests(reviewer, { page: 12 });
    expect(findMany.mock.calls[0][0].skip).toBe(11 * WORKFLOW_PAGE_SIZE);
  });

  it("narrows by type, state and title IN THE DATABASE", async () => {
    // Filtering in memory would still only ever see the most recent rows, which
    // is the defect wearing a different hat.
    const { service, where } = makeService([row(1)]);
    await service.listRequests(reviewer, { type: "FEE_SCHEDULE", state: "APPROVED", q: "march" });
    expect(where()).toMatchObject({
      type: "FEE_SCHEDULE",
      state: "APPROVED",
      title: { contains: "march", mode: "insensitive" },
    });
  });

  it("ignores a blank search rather than matching on empty string", async () => {
    const { service, where } = makeService([row(1)]);
    await service.listRequests(reviewer, { q: "   " });
    expect(where()).not.toHaveProperty("title");
  });

  it("keeps the default: no filters, most recent first", async () => {
    const { service, findMany } = makeService([row(1)]);
    await service.listRequests(reviewer, {});
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(findMany.mock.calls[0][0].skip).toBe(0);
  });
});

describe("'waiting on me'", () => {
  const pending = (i: number, stage: number) =>
    row(i, { state: "PENDING_REVIEW", stages: STAFF_REQUEST_CHAIN, currentStage: stage });

  it("reads the LIVE set and narrows it, rather than paging the database", async () => {
    // Whether a request awaits YOU depends on the stage permission, which lives
    // inside a JSON column — not something to filter on in SQL. Live work is
    // bounded by what the school is doing now, so that set is safe to narrow in
    // memory; history is not, which is why only this branch does it.
    const rows = [pending(1, 2), pending(2, 0), pending(3, 2)];
    const { service, findMany, count } = makeService(rows);
    const res = await service.listRequests(reviewer, { mine: true });
    expect(findMany.mock.calls[0][0].take).toBe(LIST_CAP);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ state: "PENDING_REVIEW" });
    // Only the two at the principal stage — this reviewer cannot decide stage 0.
    expect(res.items.map((i) => i.id)).toEqual(["w1", "w3"]);
    expect(res.total).toBe(2);
    // No wasted COUNT: the number that matters is the narrowed one.
    expect(count).not.toHaveBeenCalled();
  });

  it("counts what is waiting, not what is pending", async () => {
    const { service } = makeService([pending(1, 0), pending(2, 0)]);
    const res = await service.listRequests(reviewer, { mine: true });
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
  });
});

describe("who may see what", () => {
  it("a non-reviewer is still scoped to their own requests", async () => {
    // The filters must never widen the scope. This is the one that would be a
    // disclosure bug rather than an inconvenience.
    const { service, where } = makeService([row(1)]);
    await service.listRequests(
      { schoolId: "A", userId: "teacher", roles: [], permissions: [WORKFLOW_PERMISSIONS.READ] },
      { type: "LEAVE", q: "anything" },
    );
    expect(where()).toMatchObject({ initiatorId: "teacher" });
  });
});
