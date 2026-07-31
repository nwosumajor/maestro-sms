// =============================================================================
// GroupService — the cross-campus console a proprietor runs a chain from
// =============================================================================
// This service had no tests, and three of its numbers were wrong:
//
//   • STAFF counted `employee` rows — employment RECORDS — so a campus that had
//     not filled in its HR register reported ZERO staff while employing forty.
//   • MONEY summed amountMinor with no currency in the query, so a group with one
//     USD campus added dollars to naira and the page printed ₦ in front.
//   • A director of TWO groups saw only the first, silently.
//
// Each has a test here, because each produced a confident, plausible, wrong figure
// — the kind nobody questions until a board meeting.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { GroupService } from "../../src/group/group.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const DIRECTOR = "d-1";
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const director: Principal = { schoolId: A, userId: DIRECTOR, roles: ["principal"], permissions: [] };

type Over = Record<string, unknown>;

function makeService(over: Over = {}) {
  const groups = (over.groups as unknown[]) ?? [
    { groupId: "g-1", group: { id: "g-1", name: "Alpha Group", members: [{ schoolId: A }, { schoolId: B }] } },
  ];
  const client = {
    schoolGroupDirector: { findMany: jest.fn().mockResolvedValue(groups) },
    school: {
      findMany: jest.fn().mockResolvedValue([
        { id: A, name: "Alpha Campus", slug: "alpha", status: "ACTIVE" },
        { id: B, name: "Beta Campus", slug: "beta", status: "ACTIVE" },
      ]),
      findFirst: jest.fn().mockResolvedValue({ id: A, name: "Alpha Campus", slug: "alpha", status: "ACTIVE" }),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: A, plan: "PREMIUM", status: "ACTIVE", currentPeriodEnd: null },
        { schoolId: B, plan: "STANDARD", status: "PAST_DUE", currentPeriodEnd: null },
      ]),
      findFirst: jest.fn().mockResolvedValue({ plan: "PREMIUM", status: "ACTIVE", currentPeriodEnd: null }),
    },
    attendanceRecord: {
      // Keyed on the WHERE clause rather than call order: a sequential mock breaks
      // the moment a test calls overview() twice, and it would hide a real change
      // in query order behind a fixture failure.
      groupBy: jest.fn(async (args: { where?: { status?: unknown } }) =>
        args?.where?.status
          ? [{ schoolId: A, _count: { _all: 95 } }, { schoolId: B, _count: { _all: 30 } }]
          : [{ schoolId: A, _count: { _all: 100 } }, { schoolId: B, _count: { _all: 50 } }],
      ),
    },
    attendanceSession: {
      groupBy: jest.fn().mockResolvedValue([{ schoolId: A, _count: { _all: 20 } }, { schoolId: B, _count: { _all: 8 } }]),
    },
    invoice: { groupBy: jest.fn().mockResolvedValue([]) },
    class: { count: jest.fn().mockResolvedValue(12) },
    $queryRaw: jest.fn(async (q: unknown) => {
      const sql = JSON.stringify(q);
      // headcountBySchool
      if (sql.includes("user_role")) {
        return [
          { schoolId: A, students: 800, staff: 60, parents: 700 },
          { schoolId: B, students: 400, staff: 0, parents: 350 },
        ];
      }
      if (sql.includes("date_trunc")) return [];
      if (sql.includes("FROM invoice i")) {
        return [
          { schoolId: A, currency: "NGN", total: 5_000_00 },
          { schoolId: B, currency: "USD", total: 900_00 },
        ];
      }
      // payment joins (collected in period, then collected against open invoices)
      return [
        { schoolId: A, currency: "NGN", total: 2_000_00 },
        { schoolId: B, currency: "USD", total: 100_00 },
      ];
    }),
    ...(over.client as Over),
  };
  const db = { runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) };
  const audit = { record: jest.fn() };
  const svc = new GroupService(db as never, audit as never, { client } as never);
  return { svc, client, audit };
}

describe("GroupService.overview", () => {
  it("counts staff as PEOPLE, not employment records", async () => {
    // The bug: `employee.groupBy` counted HR rows. Two of three live campuses had
    // none, so the console reported zero staff for schools employing dozens.
    const { svc, client } = makeService();
    const out = await svc.overview(director);
    expect(out.schools.find((s) => s.name === "Alpha Campus")!.staff).toBe(60);
    expect(out.totals.staff).toBe(60);
    // And it must not consult the employee table at all any more.
    expect((client as { employee?: unknown }).employee).toBeUndefined();
  });

  it("NEVER adds one currency to another", async () => {
    // The bug: a single collected/outstanding number summed NGN and USD, and the
    // page labelled the result with a naira sign.
    const { svc } = makeService();
    const out = await svc.overview(director);
    expect(Object.keys(out.totals.byCurrency).sort()).toEqual(["NGN", "USD"]);
    expect(out.totals.byCurrency.NGN.collectedMinor).toBe(2_000_00);
    expect(out.totals.byCurrency.USD.collectedMinor).toBe(100_00);
    // Each campus reports in its own currency.
    expect(out.schools.find((s) => s.name === "Beta Campus")!.money).toEqual([
      { currency: "USD", collectedMinor: 100_00, outstandingMinor: 800_00 },
    ]);
  });

  it("shows EVERY group the caller directs, not just the first", async () => {
    const { svc } = makeService({
      groups: [
        { groupId: "g-1", group: { id: "g-1", name: "Alpha Group", members: [{ schoolId: A }] } },
        { groupId: "g-2", group: { id: "g-2", name: "Beta Group", members: [{ schoolId: B }] } },
      ],
    });
    const out = await svc.overview(director);
    expect(out.groups.map((g) => g.name)).toEqual(["Alpha Group", "Beta Group"]);
    expect(out.groupId).toBe("g-1"); // first by default
    const second = await svc.overview(director, { groupId: "g-2" });
    expect(second.groupName).toBe("Beta Group");
  });

  it("404s a group the caller does not direct — indistinguishable from absent", async () => {
    const { svc } = makeService();
    await expect(svc.overview(director, { groupId: "someone-elses" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a non-director", async () => {
    const { svc } = makeService({ client: { schoolGroupDirector: { findMany: jest.fn().mockResolvedValue([]) } } });
    await expect(svc.overview(director)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("flags the campuses that need attention, worst first", async () => {
    const { svc } = makeService();
    const out = await svc.overview(director);
    // Beta: past due, no staff, and 60% attendance. Alpha: healthy at 95%.
    expect(out.schools[0].name).toBe("Beta Campus");
    expect(out.schools[0].flags).toEqual(expect.arrayContaining(["BILLING", "NO_STAFF", "LOW_ATTENDANCE"]));
    expect(out.schools[1].flags).toEqual([]);
    expect(out.flagged).toBe(1);
  });

  it("counts LATE and EXCUSED as attending — the report card's rule", async () => {
    // 95 of 100 at Alpha, where the 95 includes late and excused. A stricter rule
    // here would contradict what that campus's own staff see.
    const { svc } = makeService();
    const out = await svc.overview(director);
    expect(out.schools.find((s) => s.name === "Alpha Campus")!.attendancePct).toBe(95);
  });

  it("defaults to a MONTH, not a single day", async () => {
    // It used to report attendance for today only, so the page was blank on a
    // weekend, on a holiday, and every morning before registers were taken.
    const { svc } = makeService();
    const out = await svc.overview(director);
    expect(out.period.key).toBe("month");
    expect(out.period.to.getTime() - out.period.from.getTime()).toBeGreaterThan(24 * 3600_000);
  });

  it("returns an empty group without querying campuses", async () => {
    const { svc, client } = makeService({
      groups: [{ groupId: "g-1", group: { id: "g-1", name: "Empty", members: [] } }],
    });
    const out = await svc.overview(director);
    expect(out.schools).toEqual([]);
    expect(client.school.findMany).not.toHaveBeenCalled();
  });

  it("audits every cross-campus read", async () => {
    const { svc, audit } = makeService();
    await svc.overview(director);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "group.overview.read", actorId: DIRECTOR }),
      expect.anything(),
    );
  });
});

describe("GroupService.schoolDetail", () => {
  it("404s a campus outside the caller's groups", async () => {
    const { svc } = makeService();
    await expect(svc.schoolDetail(director, "cccccccc-3333-3333-3333-333333333333")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns six months of trend for a campus the caller directs", async () => {
    const { svc, audit } = makeService();
    const out = await svc.schoolDetail(director, A);
    expect(out.name).toBe("Alpha Campus");
    expect(out.trend).toHaveLength(6);
    expect(out.students).toBe(800);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "group.school.read" }),
      expect.anything(),
    );
  });
});

describe("GroupService.overviewCsv", () => {
  it("emits one row per campus PER CURRENCY, and guards formula injection", async () => {
    const { svc } = makeService({
      client: {
        school: {
          findMany: jest.fn().mockResolvedValue([{ id: A, name: "=cmd|calc", slug: "x", status: "ACTIVE" }]),
          findFirst: jest.fn(),
        },
      },
    });
    const csv = await svc.overviewCsv(director);
    // A leading = would execute in a spreadsheet; it must be quoted out.
    expect(csv).toContain("'=cmd|calc");
    expect(csv.split("\n")[1]).toContain("Currency");
  });
});
