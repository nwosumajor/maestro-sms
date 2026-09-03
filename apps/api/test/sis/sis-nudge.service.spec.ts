// =============================================================================
// SisNudgeService — the daily profile-completion nudge
// =============================================================================
// A daily job that emails pupils is only acceptable if it is disciplined. The
// properties that make it so:
//   * it nudges ONLY while the pupil owes something (INCOMPLETE /
//     CHANGES_REQUESTED) — never once SUBMITTED, when the wait is on staff;
//   * `lastNudgedAt` + the interval makes a DAILY run idempotent, so re-running it
//     (or a redeploy re-firing it) sends nothing extra;
//   * the message is derived from the SAME pure helper the form uses, so it can
//     never name a field the form doesn't ask for;
//   * guardians are copied — they're who actually supplies a date of birth;
//   * one failure never aborts the sweep;
//   * no privileged DB configured ⇒ DISABLED, not half-running;
//   * a school-scoped run (the on-demand button) cannot reach another tenant.

import { SisNudgeService } from "../../src/sis/sis-nudge.service";
import { SIS_NUDGE_INTERVAL_DAYS } from "../../src/sis/sis.constants";

const BASE = {
  id: "pf1",
  schoolId: "A",
  studentId: "stu1",
  profileStatus: "INCOMPLETE",
  reviewNote: null as string | null,
  dateOfBirth: null as Date | null,
  gender: null as string | null,
  phone: null as string | null,
  addressLine1: null as string | null,
  city: null as string | null,
  state: null as string | null,
};

function makeService(opts: { profiles?: Record<string, unknown>[]; guardians?: { studentId: string; parentId: string }[]; noDb?: boolean } = {}) {
  const findMany = jest.fn().mockResolvedValue(opts.profiles ?? []);
  const update = jest.fn().mockResolvedValue({});
  // `updateMany` and `enqueueMany` exist on every real client; a stub without
  // them models something the system cannot produce. The nudge stamps every
  // pupil in ONE statement and writes one notification row per GROUP.
  const updateMany = jest.fn((a: { where: { id: { in: string[] } } }) =>
    Promise.resolve({ count: a.where.id.in.length }));
  const parentFindMany = jest.fn().mockResolvedValue(opts.guardians ?? []);
  const client = opts.noDb
    ? null
    : { studentProfile: { findMany, update, updateMany }, parentChild: { findMany: parentFindMany } };
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // Fan a grouped send into the per-recipient spy, so every assertion below
  // still asks WHAT a pupil was told rather than which call told them.
  const enqueueMany = jest.fn((actor: unknown, to: string[], input: Record<string, unknown>) => {
    // The real enqueueMany ISOLATES per-recipient failures and reports counts;
    // a fan that let one rejection escape would crash the worker instead.
    let failed = 0;
    for (const recipientId of to) {
      try { const r = enqueue(actor, { ...input, recipientId }); if (r?.catch) r.catch(() => { failed += 1; }); }
      catch { failed += 1; }
    }
    return Promise.resolve({ created: to.length - failed, failed });
  });
  const service = new SisNudgeService({ client } as never, { enqueue, enqueueMany } as never);
  return { service, findMany, update, updateMany, enqueue, enqueueMany };
}

describe("SisNudgeService", () => {
  it("is DISABLED (no-op) without a privileged database", async () => {
    const { service, enqueue } = makeService({ noDb: true });
    await expect(service.sweep()).resolves.toEqual({ nudged: 0, scanned: 0, skipped: "NO_DB" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("targets ONLY pupils who still owe something, never SUBMITTED ones", async () => {
    const { service, findMany } = makeService();
    await service.sweep();
    const where = findMany.mock.calls[0][0].where;
    expect(where.profileStatus).toEqual({ in: ["INCOMPLETE", "CHANGES_REQUESTED"] });
    expect(JSON.stringify(where)).not.toContain("SUBMITTED");
  });

  it("only re-nudges past the interval — this is what makes a DAILY job idempotent", async () => {
    const { service, findMany } = makeService();
    const before = Date.now();
    await service.sweep();
    const where = findMany.mock.calls[0][0].where;
    // Either never nudged, or last nudged before the cutoff.
    expect(where.OR[0]).toEqual({ lastNudgedAt: null });
    const cutoff = where.OR[1].lastNudgedAt.lt as Date;
    const expected = before - SIS_NUDGE_INTERVAL_DAYS * 24 * 3600 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });

  it("names the ACTUAL missing fields, and stamps lastNudgedAt", async () => {
    const { service, enqueue, updateMany } = makeService({
      profiles: [{ ...BASE, dateOfBirth: new Date("2012-01-01"), gender: "M", phone: "080", addressLine1: "1 St" }],
    });
    const res = await service.sweep();
    expect(res).toMatchObject({ nudged: 1, scanned: 1 });
    const body = enqueue.mock.calls[0][1].body as string;
    expect(body).toContain("city");
    expect(body).toContain("state");
    expect(body).not.toContain("phone"); // already supplied
    // The PROPERTY: a pupil who was nudged is stamped, so tomorrow's run skips
    // them. Which Prisma call does the stamping is not the property — it used to
    // be one UPDATE per pupil and is now one statement per chunk.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["pf1"] } }, data: { lastNudgedAt: expect.any(Date) } }),
    );
  });

  it("asks a COMPLETE-but-unsubmitted pupil to submit, not to fill anything in", async () => {
    const { service, enqueue } = makeService({
      profiles: [
        {
          ...BASE,
          dateOfBirth: new Date("2012-01-01"),
          gender: "M",
          phone: "080",
          addressLine1: "1 St",
          city: "Lagos",
          state: "Lagos",
        },
      ],
    });
    await service.sweep();
    expect(enqueue.mock.calls[0][1].title).toBe("Submit your school profile");
  });

  it("repeats the reviewer's note when changes were requested", async () => {
    const { service, enqueue } = makeService({
      profiles: [{ ...BASE, profileStatus: "CHANGES_REQUESTED", reviewNote: "Date of birth looks wrong" }],
    });
    await service.sweep();
    expect(enqueue.mock.calls[0][1].title).toBe("Your school profile needs a change");
    expect(enqueue.mock.calls[0][1].body).toContain("Date of birth looks wrong");
  });

  it("copies the pupil's guardians", async () => {
    const { service, enqueue } = makeService({
      profiles: [BASE],
      guardians: [
        { studentId: "stu1", parentId: "par1" },
        { studentId: "stu1", parentId: "par2" },
      ],
    });
    await service.sweep();
    const recipients = enqueue.mock.calls.map((c) => c[1].recipientId);
    expect(recipients).toEqual(["stu1", "par1", "par2"]);
  });

  it("one failing pupil does not abort the sweep", async () => {
    const { service, updateMany, enqueue } = makeService({
      profiles: [
        { ...BASE, id: "pf1", studentId: "stu1" },
        { ...BASE, id: "pf2", studentId: "stu2" },
      ],
    });
    // A failing WRITE must not cost the sweep. Both pupils are still told; the
    // stamp is what is lost, and losing it costs a duplicate notice tomorrow
    // rather than a pupil who is never chased.
    updateMany.mockRejectedValueOnce(new Error("db blip"));
    const res = await service.sweep();
    expect(res.scanned).toBe(2);
    expect(res.nudged).toBe(0); // nothing stamped, so both are chased again
    expect(enqueue).toHaveBeenCalledTimes(2); // and both WERE told
  });

  it("a school-scoped run cannot reach another tenant", async () => {
    const { service, findMany } = makeService();
    await service.sweep("school-A");
    expect(findMany.mock.calls[0][0].where.schoolId).toBe("school-A");
  });

  it("the scheduled run is not school-filtered (every tenant)", async () => {
    const { service, findMany } = makeService();
    await service.sweep();
    expect(findMany.mock.calls[0][0].where.schoolId).toBeUndefined();
  });
});
