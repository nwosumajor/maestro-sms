// =============================================================================
// Correcting a poll, and the line where correction becomes misrepresentation
// =============================================================================
// A poll could be created and closed and nothing else. A typo in the question, a
// missing option, the wrong audience — all permanent, so the only remedy was to
// post a second poll and leave the wrong one standing beside it.
//
// The line is the same one the exam bank draws, at the point somebody answers:
//
//   nobody has voted    a draft — question, audience and options all editable
//   somebody has        a tally has to stay attached to the question that was
//                       actually asked. Editing the question makes the result a
//                       statement about something nobody was asked; renaming an
//                       option changes what a vote meant after the fact; and
//                       removing one discards an answer somebody gave.
//
// `closesAt` is deliberately outside the rule. Extending or shortening a
// deadline changes neither what was asked nor what anyone answered, and needing
// to extend a poll people are already voting in is the ordinary case.
//
// DELETING follows the same rule, and the DATABASE is what settled it. The app
// role holds SELECT and INSERT on poll_vote and nothing else (rls/40), so a cast
// vote cannot be removed by this application at all. A first version of this
// cascaded through the votes, passed every stubbed test, and returned 500 the
// first time it met a real database. An unanswered poll can go; an answered one
// is closed.
// =============================================================================

import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PollService } from "../../src/poll/poll.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "teach", roles: ["teacher"], permissions: ["poll.manage"] };
const other: Principal = { schoolId: "A", userId: "someone-else", roles: ["teacher"], permissions: ["poll.manage"] };

function make(over: { votes?: number; poll?: unknown } = {}) {
  const update = jest.fn().mockResolvedValue({});
  const optDelete = jest.fn().mockResolvedValue({ count: 2 });
  const optCreate = jest.fn().mockResolvedValue({ count: 2 });
  const voteDelete = jest.fn().mockResolvedValue({ count: over.votes ?? 0 });
  const pollDelete = jest.fn().mockResolvedValue({});
  const log = jest.fn();
  const tx = {
    poll: {
      findFirst: jest.fn().mockResolvedValue(
        // `?? ` would swallow a deliberate null and hand back the default poll,
        // so the absent case is keyed on the property being present.
        "poll" in over
          ? over.poll
          : { id: "p1", question: "Q", audience: "ALL", status: "OPEN", createdById: "teach", closesAt: null },
      ),
      update,
      delete: pollDelete,
    },
    pollOption: { deleteMany: optDelete, createMany: optCreate },
    pollVote: { count: jest.fn().mockResolvedValue(over.votes ?? 0), deleteMany: voteDelete },
  } as unknown as TenantTx;
  const s = Object.create(PollService.prototype) as PollService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
  });
  (s as unknown as { log: unknown }).log = log;
  (s as unknown as { pollDto: unknown }).pollDto = jest.fn().mockResolvedValue({ id: "p1" });
  return { s, tx, update, optDelete, optCreate, voteDelete, pollDelete, log };
}

describe("a poll nobody has voted in", () => {
  it("takes a corrected question and audience", async () => {
    const { s, update } = make();
    await s.updatePoll(staff, "p1", { question: "  Which trip?  ", audience: "STUDENTS" });
    expect(update.mock.calls[0][0].data).toEqual({ question: "Which trip?", audience: "STUDENTS" });
  });

  it("takes a replaced option list", async () => {
    const { s, optDelete, optCreate } = make();
    await s.setPollOptions(staff, "p1", [" Zoo ", "Museum", ""]);
    expect(optDelete).toHaveBeenCalledWith({ where: { pollId: "p1" } });
    const rows = optCreate.mock.calls[0][0].data as Array<{ label: string; sequence: number }>;
    // Blank entries dropped, labels trimmed, order preserved as sequence.
    expect(rows.map((r) => r.label)).toEqual(["Zoo", "Museum"]);
    expect(rows.map((r) => r.sequence)).toEqual([0, 1]);
  });

  it("still refuses a list of fewer than two real options", async () => {
    const { s, optCreate } = make();
    await expect(s.setPollOptions(staff, "p1", ["Only one", "   "])).rejects.toThrow(/at least two options/);
    expect(optCreate).not.toHaveBeenCalled();
  });
});

describe("a poll people have voted in", () => {
  it("will not have its question changed under the tally", async () => {
    const { s, update } = make({ votes: 42 });
    await expect(s.updatePoll(staff, "p1", { question: "different" })).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("will not have its audience changed either", async () => {
    const { s } = make({ votes: 1 });
    await expect(s.updatePoll(staff, "p1", { audience: "STAFF" })).rejects.toThrow(/1 person has already voted/);
  });

  it("will not have its options replaced", async () => {
    const { s, optDelete } = make({ votes: 42 });
    await expect(s.setPollOptions(staff, "p1", ["A", "B"])).rejects.toThrow(ConflictException);
    expect(optDelete).not.toHaveBeenCalled();
  });

  it("STILL takes a new closing time", async () => {
    // The deliberate exception: a deadline is not part of what was asked.
    const { s, update } = make({ votes: 42 });
    await s.updatePoll(staff, "p1", { closesAt: "2026-09-01T00:00:00.000Z" });
    expect(update.mock.calls[0][0].data.closesAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("clears the closing time when it is set to null", async () => {
    // undefined means "leave alone" and null means "no deadline" — a poll that
    // could be given a deadline but never relieved of one is half a feature.
    const { s, update } = make({ votes: 42 });
    await s.updatePoll(staff, "p1", { closesAt: null });
    expect(update.mock.calls[0][0].data).toEqual({ closesAt: null });
  });
});

describe("deleting a poll", () => {
  it("removes an unanswered one, options first", () => {
    // Children before parents; nothing references the options once the votes
    // are known to be zero.
    const { s, optDelete, pollDelete } = make();
    return s.deletePoll(staff, "p1").then((r) => {
      expect(r).toEqual({ id: "p1", deleted: true });
      expect(optDelete.mock.invocationCallOrder[0]).toBeLessThan(pollDelete.mock.invocationCallOrder[0]);
    });
  });

  it("REFUSES one people have answered, because the database refuses it too", async () => {
    // Not a policy I chose: the app role holds SELECT and INSERT on poll_vote
    // and nothing else (rls/40), so a cast vote cannot be deleted by this
    // application. A first version cascaded through the votes and died live with
    // 42501 permission denied — the grant is the real policy, and it is the
    // stricter one.
    const { s, pollDelete } = make({ votes: 42 });
    await expect(s.deletePoll(staff, "p1")).rejects.toThrow(ConflictException);
    await expect(s.deletePoll(staff, "p1")).rejects.toThrow(/Close it instead/);
    expect(pollDelete).not.toHaveBeenCalled();
  });

  it("never tries to delete a vote", async () => {
    // The guard above is the only thing standing between this service and a 500
    // on a path a school would reach by clicking Delete.
    const { s, voteDelete } = make({ votes: 42 });
    await expect(s.deletePoll(staff, "p1")).rejects.toThrow(ConflictException);
    expect(voteDelete).not.toHaveBeenCalled();
  });
});

describe("who may do any of it", () => {
  it("is creator-or-poll.manage, the same rule closing a poll already uses", async () => {
    // Stated as it actually is rather than as I first assumed: `poll.manage` is
    // a school-wide staff permission, so a holder may manage a colleague's poll
    // — exactly what closePoll has always done. The ownership branch is what
    // lets a creator WITHOUT the permission still reach their own.
    const { s, update } = make();
    await s.updatePoll(other, "p1", { question: "x" });
    expect(update).toHaveBeenCalled();
  });

  it("someone who is neither is refused on every path", async () => {
    const stranger: Principal = { schoolId: "A", userId: "nobody", roles: ["student"], permissions: ["poll.vote"] };
    for (const call of [
      (s: PollService) => s.updatePoll(stranger, "p1", { question: "x" }),
      (s: PollService) => s.setPollOptions(stranger, "p1", ["A", "B"]),
      (s: PollService) => s.deletePoll(stranger, "p1"),
    ]) {
      const { s } = make();
      await expect(call(s)).rejects.toThrow(ForbiddenException);
    }
  });

  it("a poll that does not exist is 404 on every path", async () => {
    for (const call of [
      (s: PollService) => s.updatePoll(staff, "p1", { question: "x" }),
      (s: PollService) => s.setPollOptions(staff, "p1", ["A", "B"]),
      (s: PollService) => s.deletePoll(staff, "p1"),
    ]) {
      const { s } = make({ poll: null });
      await expect(call(s)).rejects.toThrow(NotFoundException);
    }
  });
});
