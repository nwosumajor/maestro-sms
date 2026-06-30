// =============================================================================
// PollService — anonymity, one-vote-per-member, audience gating
// =============================================================================
// The most important assertion: the DTO returned after voting carries per-option
// TALLIES only and never exposes who voted for what (no voterId in any read).

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PollService } from "../../src/poll/poll.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "teach", roles: ["teacher"], permissions: ["poll.manage", "poll.vote"] };
const student: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["poll.vote"] };

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { voteCreate: 0 };
  const groupBy = jest.fn().mockResolvedValue(over.grouped ?? [{ optionId: "o1", _count: { _all: 3 } }, { optionId: "o2", _count: { _all: 1 } }]);
  const tx = {
    poll: {
      create: jest.fn().mockResolvedValue({ id: "p1" }),
      findFirst: jest.fn().mockResolvedValue(over.poll ?? { id: "p1", question: "Q", audience: "ALL", status: "OPEN", createdById: "teach", closesAt: null }),
      findFirstOrThrow: jest.fn().mockResolvedValue(over.pollRow ?? { id: "p1", question: "Q", audience: "ALL", status: "OPEN", createdById: "teach", closesAt: null, createdAt: new Date() }),
      update: jest.fn().mockResolvedValue({}),
    },
    pollOption: {
      create: jest.fn().mockResolvedValue({ id: "o1" }),
      findFirst: jest.fn().mockResolvedValue(over.option ?? { id: "o1" }),
      findMany: jest.fn().mockResolvedValue([{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }]),
    },
    pollVote: {
      create: jest.fn(() => { calls.voteCreate++; return Promise.resolve({ id: "v1" }); }),
      findFirst: jest.fn().mockResolvedValue(over.existingVote ?? null),
      count: jest.fn().mockResolvedValue(over.count ?? 0),
      groupBy,
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "teach", name: "Teacher" }) },
  } as unknown as TenantTx;
  return { tx, calls, groupBy };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new PollService(db as never, audit as never);
}

describe("PollService", () => {
  it("creating a poll needs at least two options", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).createPoll(staff, { question: "Q", audience: "ALL", options: ["only one"] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("records a vote and returns ANONYMOUS tallies (no voter identity)", async () => {
    // Vote as staff (poll.manage) so results are visible — proving the tallies are
    // per-option counts ONLY, never a voter→option mapping.
    const { tx, calls } = makeTx({ existingVote: null });
    const dto = await svc(tx).vote(staff, "p1", "o1");
    expect(calls.voteCreate).toBe(1);
    expect(dto.options).toEqual([
      { id: "o1", label: "Yes", votes: 3 },
      { id: "o2", label: "No", votes: 1 },
    ]);
    // The DTO exposes NO voter→option mapping (no voterId field anywhere); the
    // only identity present is the public poll creator (createdById).
    expect(JSON.stringify(dto)).not.toMatch(/voterId/);
  });

  it("rejects a second vote from the same member", async () => {
    const { tx } = makeTx({ existingVote: { id: "v0" } });
    await expect(svc(tx).vote(student, "p1", "o1")).rejects.toThrow(/already voted/i);
  });

  it("blocks a student from voting in a STAFF-only poll", async () => {
    const { tx } = makeTx({ poll: { id: "p1", audience: "STAFF", status: "OPEN", createdById: "teach", closesAt: null } });
    await expect(svc(tx).vote(student, "p1", "o1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("hides tallies from a live voter (resultsVisible=false until closed)", async () => {
    const { tx } = makeTx({ poll: { id: "p1", audience: "ALL", status: "OPEN", createdById: "teach", closesAt: null }, existingVote: null });
    const dto = await svc(tx).vote(student, "p1", "o1");
    expect(dto.resultsVisible).toBe(false);
    expect(dto.options.every((o) => o.votes === 0)).toBe(true); // blinded
  });
});
