/**
 * A platform-funded scholarship that only ever reaches the biggest school is
 * not a growth lever across tenants.
 *
 * Measured on a 5,000-applicant exercise across three schools: the one holding
 * half the pupils won ALL SIX podium places across both categories, and the
 * smallest ended with no exam created at all, because none of its candidates
 * was ever qualified. Nothing in the product said so.
 */
import { BadRequestException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { userId: "op", schoolId: "plat", roles: ["super_admin"], permissions: [] } as never;
const PROG = "prog-1";

function capSvc(opts: {
  cap: number | null;
  taken: Record<string, number>;
  rows: Array<{ id: string; schoolId: string; status?: string }>;
}) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const db = {
    scholarshipProgram: {
      findFirst: async () => ({ id: PROG, maxCandidatesPerSchool: opts.cap }),
      findMany: async () => [{ id: PROG, maxCandidatesPerSchool: opts.cap }],
    },
    scholarshipApplication: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const r = opts.rows.find((x) => x.id === where.id);
        return r ? { ...r, programId: PROG, status: r.status ?? "SUBMITTED", studentId: "s" } : null;
      },
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        opts.rows
          .filter((r) => where.id.in.includes(r.id))
          .map((r) => ({ ...r, programId: PROG, status: r.status ?? "SUBMITTED" })),
      // The single path claims the row with `update`; the bulk one with
      // `updateMany`. Both exist on every real client.
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push({ where: args.where, data: args.data });
        return { id: "a0" };
      },
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: (args.where as { id: { in: string[] } }).id.in.length };
      },
      groupBy: async ({ where }: { where: { schoolId: { in: string[] } } }) =>
        where.schoolId.in
          .filter((id) => opts.taken[id])
          .map((id) => ({ schoolId: id, _count: { _all: opts.taken[id] } })),
    },
    school: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id === "big" ? "St. Andrews Academy" : "Elshaddi" })),
    },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, { client: () => db, auditOwn: async () => undefined });
  return { s, updates };
}

describe("one school cannot crowd out the rest", () => {
  it("lets a school fill exactly its remaining seats and no more", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, schoolId: "big" }));
    const { s, updates } = capSvc({ cap: 5, taken: { big: 2 }, rows });
    const out = await s.decideBulk(P, rows.map((r) => r.id), "QUALIFY");
    // Two already qualified, so three seats remain.
    expect(out.updated).toBe(3);
    expect((updates[0].where as { id: { in: string[] } }).id.in).toEqual(["a0", "a1", "a2"]);
  });

  // The refusal names the SCHOOL and the number. A uuid sends an operator away
  // to look it up, and "limit reached" does not say whose.
  it("says which school is full, and what the limit is", async () => {
    const rows = [{ id: "a0", schoolId: "big" }];
    const { s } = capSvc({ cap: 5, taken: { big: 5 }, rows });
    const out = await s.decideBulk(P, ["a0"], "QUALIFY");
    expect(out.updated).toBe(0);
    expect(out.skipped[0].reason).toMatch(/St\. Andrews Academy.*limit of 5/);
  });

  // AWARDED COUNTS AGAINST THE CAP: an awarded candidate qualified first and
  // their seat is taken. Counting only QUALIFIED would let a school exceed the
  // cap as its earlier candidates are promoted out of that status.
  it("counts AWARDED against the cap, not only QUALIFIED", async () => {
    const rows = [{ id: "a0", schoolId: "big" }];
    let asked: unknown = null;
    const { s } = capSvc({ cap: 3, taken: { big: 3 }, rows });
    const db = (s as unknown as { client: () => Record<string, never> }).client();
    const app = (db as unknown as { scholarshipApplication: { groupBy: unknown } }).scholarshipApplication;
    const orig = app.groupBy as (a: unknown) => Promise<unknown>;
    app.groupBy = async (a: { where: { status: { in: string[] } } }) => {
      asked = a.where.status.in;
      return orig(a);
    };
    await s.decideBulk(P, ["a0"], "QUALIFY");
    expect(asked).toEqual(["QUALIFIED", "AWARDED"]);
  });

  // A CAP ON ONE PATH IS NOT A CAP. The single review must refuse where the
  // bulk one skips.
  it("refuses a single QUALIFY into a full school", async () => {
    const { s } = capSvc({ cap: 5, taken: { big: 5 }, rows: [{ id: "a0", schoolId: "big" }] });
    await expect(s.decide(P, "a0", { action: "QUALIFY" })).rejects.toThrow(/already has 5 candidate/);
  });

  it("lets a single QUALIFY through where there is room", async () => {
    const { s, updates } = capSvc({ cap: 5, taken: { big: 1 }, rows: [{ id: "a0", schoolId: "big" }] });
    Object.assign(s, { listApplicationById: async () => [{ id: "a0" }], notifyFamily: async () => undefined });
    await s.decide(P, "a0", { action: "QUALIFY" });
    expect(updates.length).toBeGreaterThan(0);
  });

  // NULL MEANS NO CAP — every programme authored before the column existed, so
  // nothing moves for them.
  it("is unlimited when the programme sets no cap", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, schoolId: "big" }));
    const { s } = capSvc({ cap: null, taken: { big: 999 }, rows });
    const out = await s.decideBulk(P, rows.map((r) => r.id), "QUALIFY");
    expect(out.updated).toBe(40);
    expect(out.skipped).toEqual([]);
  });

  // Only QUALIFY consumes a seat. Shortlisting or rejecting must not be
  // throttled by a cap on who may SIT.
  it("does not apply the cap to other actions", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, schoolId: "big" }));
    const { s } = capSvc({ cap: 1, taken: { big: 99 }, rows });
    const out = await s.decideBulk(P, rows.map((r) => r.id), "SHORTLIST");
    expect(out.updated).toBe(10);
  });
});

describe("the spread says whether a school is represented at all", () => {
  it("reports applied / qualified / awarded and the seats each has left", async () => {
    const { s } = capSvc({ cap: 5, taken: {}, rows: [] });
    const db = (s as unknown as { client: () => Record<string, never> }).client();
    (db as unknown as { scholarshipApplication: { groupBy: unknown } }).scholarshipApplication.groupBy = async () => [
      { schoolId: "big", status: "QUALIFIED", _count: { _all: 5 } },
      { schoolId: "big", status: "SUBMITTED", _count: { _all: 2495 } },
      { schoolId: "small", status: "SUBMITTED", _count: { _all: 1000 } },
    ];
    const out = await s.schoolSpread(P, PROG);
    // Most applicants first: the school most likely to crowd the field is the
    // one an operator wants at the top.
    expect(out[0].schoolName).toBe("St. Andrews Academy");
    expect(out[0]).toMatchObject({ applied: 2500, qualified: 5, seatsLeft: 0 });
    // The school with NOBODY qualified — the half a cap alone cannot answer.
    expect(out[1]).toMatchObject({ applied: 1000, qualified: 0, awarded: 0, seatsLeft: 5 });
  });

  // Null is NO CAP, which is a different statement from "full".
  it("reports seatsLeft as null when the programme sets no cap", async () => {
    const { s } = capSvc({ cap: null, taken: {}, rows: [] });
    const db = (s as unknown as { client: () => Record<string, never> }).client();
    (db as unknown as { scholarshipApplication: { groupBy: unknown } }).scholarshipApplication.groupBy = async () => [
      { schoolId: "big", status: "QUALIFIED", _count: { _all: 9000 } },
    ];
    const out = await s.schoolSpread(P, PROG);
    expect(out[0].seatsLeft).toBeNull();
  });
});
