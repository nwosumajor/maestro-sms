// =============================================================================
// Whose turn is it — the queue the review chain never had
// =============================================================================
// A pupil profile goes: SUBMITTED by the pupil or their parent → checked by the
// CLASS SUPERVISOR → approved by the SCHOOL OFFICE. All three endpoints act on
// one named pupil, which is useless until you know which pupil — so a supervisor
// had no way to learn anything had been submitted, and the office had no way to
// see what the supervisor had already passed.
//
// The queue decides the stage server-side rather than asking the reader which
// reviewer they are, and it applies the SAME relationship the review endpoint
// enforces — so it can never offer a row whose action would then 404.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const supervisor: Principal = {
  schoolId: "S",
  userId: "sup-1",
  roles: ["teacher"],
  permissions: ["student.profile.read"],
};
const office: Principal = {
  schoolId: "S",
  userId: "adm-1",
  roles: ["school_admin"],
  permissions: ["student.profile.read", "rbac.manage"],
};
const outsider: Principal = {
  schoolId: "S",
  userId: "other-1",
  roles: ["teacher"],
  permissions: ["student.profile.read"],
};

const PROFILES = [
  // Waiting on a supervisor.
  { studentId: "stu-1", profileStatus: "SUBMITTED", submittedAt: new Date("2026-08-01"), supervisorReviewedAt: null },
  // Checked — waiting on the office.
  { studentId: "stu-2", profileStatus: "SUBMITTED", submittedAt: new Date("2026-08-02"), supervisorReviewedAt: new Date("2026-08-03") },
];

/** The stub used to hand back every profile whatever was asked for, which made
 *  it blind to WHERE the narrowing happens. That mattered the day the queue
 *  stopped filtering in Node and started asking the database instead: the cap
 *  was being spent on other people's pupils, so a supervisor whose class
 *  submitted after the first 500 saw an empty screen. A stub that ignores the
 *  where cannot tell the two implementations apart. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === "OR") return (v as Array<Record<string, unknown>>).some((c) => matches(row, c));
    if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    if (v && typeof v === "object" && "not" in (v as object)) return row[k] !== (v as { not: unknown }).not;
    return row[k] === v;
  });
}

function makeService(opts: { supervises?: string[] } = {}) {
  const { supervises = ["stu-1"] } = opts;
  const tx = {
    studentProfile: {
      findMany: jest.fn(async (a: { where: Record<string, unknown> }) => PROFILES.filter((r) => matches(r, a.where))),
    },
    enrollment: {
      findMany: jest.fn(async (a: { where: Record<string, unknown> }) => {
        // Two different reads: the supervised-classes filter, and the class-name
        // lookup. The first carries a class filter, the second does not.
        const forSupervisor = "class" in a.where;
        if (forSupervisor) return supervises.map((studentId) => ({ studentId }));
        return [{ studentId: "stu-1", class: { name: "JSS 1A" } }, { studentId: "stu-2", class: { name: "JSS 2B" } }];
      }),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: "stu-1", name: "Ada" },
        { id: "stu-2", name: "Bola" },
      ]),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const service = new SisService(db as never, { record: jest.fn() } as never, { enqueue: jest.fn() } as never);
  return { service, tx };
}

describe("who sees what in the queue", () => {
  it("a supervisor sees the pupil awaiting THEIR check", async () => {
    const { service } = makeService({ supervises: ["stu-1"] });
    const rows = await service.profileReviewQueue(supervisor);
    expect(rows.map((r) => r.studentId)).toEqual(["stu-1"]);
    expect(rows[0]).toMatchObject({ stage: "SUPERVISOR", studentName: "Ada", className: "JSS 1A" });
  });

  it("a supervisor does NOT see one already passed to the office", async () => {
    // They cannot act on it, so offering it would only produce a refusal.
    const { service } = makeService({ supervises: ["stu-1", "stu-2"] });
    const rows = await service.profileReviewQueue(supervisor);
    expect(rows.map((r) => r.studentId)).not.toContain("stu-2");
  });

  it("a teacher who supervises neither sees nothing", async () => {
    const { service } = makeService({ supervises: [] });
    expect(await service.profileReviewQueue(outsider)).toEqual([]);
  });

  it("the office sees BOTH stages, because it can act on both", async () => {
    // school_admin is school-wide: the supervisor check is open to them too.
    const { service } = makeService();
    const rows = await service.profileReviewQueue(office);
    expect(rows.map((r) => r.stage).sort()).toEqual(["ADMIN", "SUPERVISOR"]);
  });

  it("names the stage, so two reviewers do not each assume the other has it", async () => {
    const { service } = makeService();
    const rows = await service.profileReviewQueue(office);
    expect(rows.find((r) => r.studentId === "stu-2")?.stage).toBe("ADMIN");
  });
});

describe("what the queue reads", () => {
  it("only SUBMITTED profiles — nothing half-filled, nothing already approved", async () => {
    const { service, tx } = makeService();
    await service.profileReviewQueue(office);
    expect((tx.studentProfile.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      profileStatus: "SUBMITTED",
    });
  });

  it("uses the same supervisor relationship the review endpoint enforces", async () => {
    // If these two ever disagree, the queue offers work that then 404s.
    const { service, tx } = makeService();
    await service.profileReviewQueue(supervisor);
    const call = (tx.enrollment.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toMatchObject({ status: "ACTIVE", class: { supervisorId: "sup-1" } });
  });

  it("does not walk the roster — it starts from submitted profiles", async () => {
    const { service, tx } = makeService();
    await service.profileReviewQueue(office);
    expect((tx.studentProfile.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({ take: 500 });
  });
});
