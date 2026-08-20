// =============================================================================
// The programme budget was decorative
// =============================================================================
// The operator is asked for a "Budget (₦)" when creating a scholarship
// programme. It is validated, stored, returned in the DTO and shown back to
// them — and nothing in the codebase ever compared it to anything. Zero
// references in `decide`.
//
// So a programme budgeted at 100,000 with three 50,000 prizes could award
// 150,000, and nothing objected. A field that looks like a spending control and
// constrains nothing is worse than no field at all: it is read as a limit that
// is being observed.
//
// ZERO MEANS "NOT SET", not "spend nothing". It is the column default, so
// enforcing it literally would refuse every award on every programme whose
// budget was left blank. All four programmes in the live database happen to
// budget exactly their three prizes, so enforcement changes nothing for them —
// checked before writing it rather than assumed.
//
// The committed total is shown beside the budget, because a limit is only a
// control if the person spending can see what is left BEFORE they decide.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

const P = { schoolId: "PLAT", userId: "owner-1", roles: ["super_admin"], permissions: ["scholarship.admin"] } as never;

function make(opts: { budgetMinor: number; awarded: Array<{ awardPosition: number; awardMinor: number }> }) {
  const db = {
    scholarshipApplication: {
      findFirst: jest.fn().mockResolvedValue({
        id: "app-1", schoolId: "s1", studentId: "pupil-1", programId: "prog-1", status: "QUALIFIED",
      }),
      findMany: jest.fn().mockResolvedValue(opts.awarded),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    scholarshipProgram: {
      findFirst: jest.fn().mockResolvedValue({
        title: "Prog", awardMinor: 500_000, award2Minor: 300_000, award3Minor: 200_000,
        awardKind: "NONE", budgetMinor: opts.budgetMinor,
      }),
    },
    invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    school: { findFirst: jest.fn().mockResolvedValue({ currency: "NGN" }) },
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, { privileged: { client: db }, notifications: {}, audit: { record: jest.fn() } });
  (s as unknown as { client: unknown }).client = () => db;
  (s as unknown as { auditOwn: unknown }).auditOwn = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { notifyFamily: unknown }).notifyFamily = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { listApplicationById: unknown }).listApplicationById = jest.fn().mockResolvedValue([{ id: "app-1" }]);
  return { s, db };
}

const award = (s: ScholarshipAdminService, position: number) =>
  s.decide(P, "app-1", { action: "AWARD", position });

describe("awarding within a budget", () => {
  it("is allowed when the programme can afford it", async () => {
    const { s, db } = make({ budgetMinor: 1_000_000, awarded: [] });
    await award(s, 1); // 500,000 of 1,000,000
    expect(db.scholarshipApplication.updateMany).toHaveBeenCalled();
  });

  it("is allowed when it exactly exhausts the budget", async () => {
    // A budget is a ceiling, not a thing to stay under.
    const { s, db } = make({ budgetMinor: 800_000, awarded: [{ awardPosition: 2, awardMinor: 300_000 }] });
    await award(s, 1); // 300,000 committed + 500,000 = 800,000
    expect(db.scholarshipApplication.updateMany).toHaveBeenCalled();
  });
});

describe("awarding past a budget", () => {
  it("is refused, and says by how much is already committed", async () => {
    const { s, db } = make({ budgetMinor: 600_000, awarded: [{ awardPosition: 2, awardMinor: 300_000 }] });
    await expect(award(s, 1)).rejects.toThrow(BadRequestException);
    // Formatted through formatMoney, not minor/100 — a zero-decimal currency
    // would print a hundredth of the real figure, and the repo gates on it.
    await expect(award(s, 1)).rejects.toThrow(/already committed/);
    await expect(award(s, 1)).rejects.toThrow(/3,000/);
    expect(db.scholarshipApplication.updateMany).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the award is claimed or any money moves", async () => {
    const { s, db } = make({ budgetMinor: 100_000, awarded: [] });
    await expect(award(s, 1)).rejects.toThrow(BadRequestException);
    expect(db.scholarshipApplication.updateMany).not.toHaveBeenCalled();
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });
});

describe("a programme with no budget set", () => {
  it("is not blocked — zero is the column default, not a decision to spend nothing", async () => {
    // Enforcing 0 literally would refuse every award on every programme created
    // without a budget, which is most of the ways one can be created.
    const { s, db } = make({ budgetMinor: 0, awarded: [{ awardPosition: 2, awardMinor: 300_000 }] });
    await award(s, 1);
    expect(db.scholarshipApplication.updateMany).toHaveBeenCalled();
  });
});

describe("what the operator can see before deciding", () => {
  it("reports committed spend per programme in ONE query, not one per row", async () => {
    const { s, db } = make({ budgetMinor: 1_000_000, awarded: [] });
    (db.scholarshipProgram as unknown as { findMany: jest.Mock }).findMany = jest
      .fn()
      .mockResolvedValue([
        { id: "p1", title: "A", description: null, budgetMinor: 1_000_000, awardMinor: 1, award2Minor: null, award3Minor: null,
          awardKind: "NONE", selectionBasis: "BOTH", eligibility: null, opensAt: new Date(), closesAt: new Date(),
          status: "OPEN", category: "X", examMode: null, examAt: null, examVenue: null, examDurationMin: 30,
          examQuestions: [], createdAt: new Date() },
      ]);
    (db.scholarshipApplication.groupBy as jest.Mock).mockResolvedValue([
      { programId: "p1", _sum: { awardMinor: 250_000 } },
    ]);
    const out = await s.listPrograms();
    expect(out[0].committedMinor).toBe(250_000);
    expect(db.scholarshipApplication.groupBy).toHaveBeenCalledTimes(1);
  });
});
