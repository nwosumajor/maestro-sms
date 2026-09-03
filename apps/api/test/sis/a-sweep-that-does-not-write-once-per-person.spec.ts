/**
 * Three nightly fleet sweeps wrote one notification PER RECIPIENT — and
 * `NotificationService.enqueue` opens a tenant transaction and a queue round
 * trip each. The scholarship announce already had to be fixed for exactly this
 * ("ONE TRANSACTION PER CANDIDATE"), and `enqueueMany` was written for it; the
 * sweeps bounded by a school's ROLL never reached for it.
 *
 * Measured live across 50 schools before the fix:
 *
 *     admin/sis/nudge/run    120 pupils   7,610 ms   (63 ms a pupil)
 *     fees/reminders/run      91 bills    2,642 ms   (29 ms a bill)
 *
 * A 900-pupil school is a minute a school, on a job that runs for every school
 * on the platform every night.
 *
 * What these pin is the SHAPE: the writes must not grow one-per-person.
 */
import { SisNudgeService } from "../../src/sis/sis-nudge.service";

const BASE = {
  id: "pf", schoolId: "S", studentId: "stu", profileStatus: "INCOMPLETE",
  lastNudgedAt: null as Date | null, reviewNote: null as string | null,
  dateOfBirth: null, gender: null, phone: null, addressLine1: null, city: null, state: null,
};

function makeService(profiles: Record<string, unknown>[], guardians: { studentId: string; parentId: string }[] = []) {
  const calls: string[] = [];
  const client = {
    studentProfile: {
      findMany: jest.fn(() => { calls.push("profile.findMany"); return Promise.resolve(profiles); }),
      update: jest.fn(() => { calls.push("profile.update"); return Promise.resolve({}); }),
      updateMany: jest.fn((a: { where: { id: { in: string[] } } }) => {
        calls.push("profile.updateMany"); return Promise.resolve({ count: a.where.id.in.length });
      }),
    },
    parentChild: { findMany: jest.fn(() => { calls.push("parentChild.findMany"); return Promise.resolve(guardians); }) },
  };
  const enqueue = jest.fn(() => { calls.push("enqueue"); return Promise.resolve(undefined); });
  const enqueueMany = jest.fn((_a: unknown, to: string[], _input: { title: string; body: string }) => {
    calls.push("enqueueMany"); return Promise.resolve({ created: to.length, failed: 0 });
  });
  const service = new SisNudgeService({ client } as never, { enqueue, enqueueMany } as never);
  return { service, calls, enqueueMany };
}
const roll = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ ...BASE, id: `pf${i}`, studentId: `stu${i}`, ...over }));

describe("the profile nudge does not write once per pupil", () => {
  it("does the same number of writes for 400 pupils as for 4", async () => {
    const small = makeService(roll(4));
    await small.service.sweep();
    const big = makeService(roll(400));
    await big.service.sweep();
    expect(big.calls.length).toBe(small.calls.length);
  });

  it("never enqueues one at a time", async () => {
    const { service, calls } = makeService(roll(200));
    await service.sweep();
    expect(calls.filter((c) => c === "enqueue")).toHaveLength(0);
    expect(calls.filter((c) => c === "profile.update")).toHaveLength(0);
  });

  it("groups pupils who get the SAME message into one write", async () => {
    // 200 pupils missing the same fields is one sentence, not 200.
    const { service, enqueueMany } = makeService(roll(200));
    await service.sweep();
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect((enqueueMany.mock.calls[0]![1] as string[])).toHaveLength(200);
  });

  it("still says something DIFFERENT when the pupils need different things", async () => {
    const { service, enqueueMany } = makeService([
      { ...BASE, id: "a", studentId: "sa" },                                        // fill it in
      { ...BASE, id: "b", studentId: "sb", dateOfBirth: new Date("2012-01-01"), gender: "M",
        phone: "080", addressLine1: "1 St", city: "Lagos", state: "Lagos" },        // submit it
      { ...BASE, id: "c", studentId: "sc", profileStatus: "CHANGES_REQUESTED", reviewNote: "Fix the date" },
    ]);
    await service.sweep();
    const titles = enqueueMany.mock.calls.map((c) => c[2].title);
    expect(new Set(titles).size).toBe(3);
    expect(titles).toContain("Submit your school profile");
    expect(titles).toContain("Your school profile needs a change");
    expect(titles).toContain("Finish your school profile");
  });

  it("still reaches the pupil AND their guardians", async () => {
    const { service, enqueueMany } = makeService(roll(1), [
      { studentId: "stu0", parentId: "p1" }, { studentId: "stu0", parentId: "p2" },
    ]);
    await service.sweep();
    expect((enqueueMany.mock.calls[0]![1] as string[]).sort()).toEqual(["p1", "p2", "stu0"]);
  });

  it("stamps in CHUNKS, so one failed write does not re-chase a whole fleet", async () => {
    const { service, calls } = makeService(roll(1200));
    await service.sweep();
    // 1,200 pupils = three chunks of 500, not 1,200 statements and not one
    // statement whose failure re-nudges everybody.
    expect(calls.filter((c) => c === "profile.updateMany")).toHaveLength(3);
  });
});
