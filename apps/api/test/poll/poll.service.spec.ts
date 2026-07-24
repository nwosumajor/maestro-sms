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

  it("listPolls BATCHES its lookups and still blinds an open poll from a student", async () => {
    // Two polls: one OPEN (must stay blinded for a student), one CLOSED (results
    // visible to anyone). Proves the batched path keeps the per-poll visibility
    // rule and never leaks a voter identity.
    const optionFindMany = jest.fn().mockResolvedValue([
      { id: "o1", pollId: "p-open", label: "Yes" },
      { id: "o2", pollId: "p-open", label: "No" },
      { id: "o3", pollId: "p-closed", label: "A" },
    ]);
    const groupBy = jest.fn().mockResolvedValue([
      { pollId: "p-open", optionId: "o1", _count: { _all: 5 } },
      { pollId: "p-open", optionId: "o2", _count: { _all: 2 } },
      { pollId: "p-closed", optionId: "o3", _count: { _all: 9 } },
    ]);
    const voteFindMany = jest.fn().mockResolvedValue([{ pollId: "p-open" }]); // student voted in the open one
    const pollFindFirstOrThrow = jest.fn(); // must NOT be used (that was the N+1)
    const tx = {
      poll: {
        findMany: jest.fn().mockResolvedValue([
          { id: "p-open", question: "Open?", audience: "ALL", status: "OPEN", createdById: "teach", closesAt: null, createdAt: new Date() },
          { id: "p-closed", question: "Closed?", audience: "ALL", status: "CLOSED", createdById: "teach", closesAt: null, createdAt: new Date() },
        ]),
        findFirstOrThrow: pollFindFirstOrThrow,
      },
      pollOption: { findMany: optionFindMany },
      pollVote: { findMany: voteFindMany, groupBy },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "teach", name: "Teacher" }]) },
    } as unknown as TenantTx;

    const dtos = await svc(tx).listPolls(student);
    const open = dtos.find((d) => d.id === "p-open");
    const closed = dtos.find((d) => d.id === "p-closed");
    // OPEN poll: student sees NO per-option tallies (blind voting preserved)...
    expect(open?.resultsVisible).toBe(false);
    expect(open?.options.every((o) => o.votes === 0)).toBe(true);
    expect(open?.totalVotes).toBe(7); // total is fine, the split is not
    expect(open?.hasVoted).toBe(true); // their OWN vote flag
    // ...CLOSED poll: results are open to everyone.
    expect(closed?.resultsVisible).toBe(true);
    expect(closed?.options[0]?.votes).toBe(9);
    expect(closed?.hasVoted).toBe(false);
    // Batched: ONE options query, ONE tally groupBy, and no per-poll re-fetch.
    expect(optionFindMany).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(pollFindFirstOrThrow).not.toHaveBeenCalled();
    // The only voterId filter is the CALLER's own.
    expect(voteFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ voterId: "stu1" }) }));
  });
});
