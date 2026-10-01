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
import { GROUP_NO_SUBSCRIPTION, GROUP_PERIODS, resolveRegion, schoolDateString, schoolMidnight } from "@sms/types";

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
    attendanceSession: {},
    // Both campuses run a current term with dates, so registers can be measured
    // against the days that were due.
    term: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: A, isCurrent: true, startDate: new Date("2020-01-01T00:00:00Z"), endDate: new Date("2099-12-31T00:00:00Z") },
        { schoolId: B, isCurrent: true, startDate: new Date("2020-01-01T00:00:00Z"), endDate: new Date("2099-12-31T00:00:00Z") },
      ]),
    },
    invoice: { groupBy: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { count: jest.fn().mockResolvedValue(12) },
    // Routed on the SQL each figure is computed with, never on call order: a
    // sequential mock breaks the moment a test calls overview() twice, and it
    // would hide a real change in query order behind a fixture failure.
    $queryRaw: jest.fn(async (q: unknown) => {
      const sql = JSON.stringify(q);
      // headcountBySchool
      if (sql.includes("user_role")) {
        return [
          { schoolId: A, students: 800, staff: 60, parents: 700 },
          { schoolId: B, students: 400, staff: 0, parents: 350 },
        ];
      }
      // The campus page's six-month trend.
      if (sql.includes("to_char")) return [];
      // Expected registers and how many were taken: A took all 20 due, B 8 of 10.
      if (sql.includes("generate_series")) {
        return [
          { schoolId: A, expected: 20, covered: 20 },
          { schoolId: B, expected: 10, covered: 8 },
        ];
      }
      if (sql.includes("attendance_session")) return [{ schoolId: A, n: 20 }, { schoolId: B, n: 8 }];
      if (sql.includes("attendance_record")) {
        return [
          // 80 present + 10 late of 100 = 90%. Counting the 5 EXCUSED as
          // attending would make it 95 — the rule the overview used to apply.
          { schoolId: A, present: 80, late: 10, absent: 5, excused: 5 },
          { schoolId: B, present: 25, late: 5, absent: 10, excused: 10 },
        ];
      }
      // What is owed now — each open invoice's positive balance.
      if (sql.includes("WITH open")) {
        return [
          { schoolId: A, currency: "NGN", current: 1_000_00, d1_30: 2_000_00, d31_60: 0, d60plus: 0 },
          { schoolId: B, currency: "USD", current: 800_00, d1_30: 0, d31_60: 0, d60plus: 0 },
        ];
      }
      // Net collected in the window.
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
      expect.objectContaining({ currency: "USD", collectedMinor: 100_00, outstandingMinor: 800_00, overdueMinor: 0 }),
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

  it("counts LATE as attending and EXCUSED as an absence — the platform's ONE rule", async () => {
    // `attendanceRatePct`, the rule the report card prints. This test used to
    // assert the opposite ("LATE and EXCUSED count as attending — the report
    // card's rule"), which the report card has never used, and the campus page
    // applied the real rule — so one campus showed two rates.
    const { svc } = makeService();
    const out = await svc.overview(director);
    expect(out.schools.find((s) => s.name === "Alpha Campus")!.attendancePct).toBe(90);
    const detail = await svc.schoolDetail(director, A);
    expect(detail.attendancePct).toBe(90);
  });

  it("defaults to a MONTH, cut at midnight in the CAMPUS's own zone", async () => {
    // It used to report today only (blank every weekend), and later cut the
    // month at the SERVER's midnight — an hour late in Lagos.
    const { svc } = makeService();
    const out = await svc.overview(director);
    expect(out.period.key).toBe("month");
    // The fixture campuses carry no region, so they resolve to the platform's
    // home country. Asserted on the window's START, never its length: on the 1st
    // the month-to-date window is a few hours long.
    const tz = resolveRegion({}).timezone;
    const firstOfMonth = `${schoolDateString(tz).slice(0, 7)}-01`;
    expect(new Date(out.period.from).toISOString()).toBe(schoolMidnight(firstOfMonth, tz).toISOString());
  });

  it("treats an unknown period as the default rather than failing", async () => {
    const { svc } = makeService();
    const out = await svc.overview(director, { period: "fortnight" });
    expect(out.period.key).toBe("month");
  });

  it("flags a campus with NO subscription instead of reporting it ACTIVE", async () => {
    // A campus with no row is on the STANDARD floor, not paid up. It used to
    // default to "ACTIVE" here and hide the gap.
    const { svc } = makeService({
      client: {
        schoolSubscription: {
          findMany: jest.fn().mockResolvedValue([{ schoolId: B, plan: "STANDARD", status: "ACTIVE", currentPeriodEnd: null }]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    });
    const out = await svc.overview(director);
    const alpha = out.schools.find((s) => s.name === "Alpha Campus")!;
    expect(alpha.subscriptionStatus).toBe(GROUP_NO_SUBSCRIPTION);
    expect(alpha.flags).toContain("BILLING");
    expect((await svc.schoolDetail(director, A)).flags).toContain("BILLING");
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

describe("the campus page reports the row it was clicked from", () => {
  // The overview computed its figures one way and the campus page another, and
  // the web never even sent the campus page a period. Both now call one
  // `campusFigures`; this holds them to it for every period a director can pick.
  for (const { key } of GROUP_PERIODS) {
    it(`agrees on every figure and flag over "${key}"`, async () => {
      const { svc } = makeService();
      const row = (await svc.overview(director, { period: key })).schools.find((s) => s.schoolId === A)!;
      const detail = await svc.schoolDetail(director, A, { period: key });
      expect(detail.period.key).toBe(key);
      expect({
        attendancePct: detail.attendancePct,
        registersTaken: detail.registersTaken,
        money: detail.money,
        subscriptionStatus: detail.subscriptionStatus,
        flags: detail.flags,
      }).toEqual({
        attendancePct: row.attendancePct,
        registersTaken: row.registersTaken,
        money: row.money,
        subscriptionStatus: row.subscriptionStatus,
        flags: row.flags,
      });
    });
  }
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
