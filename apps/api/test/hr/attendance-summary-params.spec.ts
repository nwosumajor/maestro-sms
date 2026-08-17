// =============================================================================
// A guard that read as complete and let the one bad value through
// =============================================================================
// The staff attendance summary — the monthly report an HR clerk or principal
// opens — answered 500 to a call with no parameters, which is the first thing
// anyone tries. Found by probing every claim in the product against the running
// system, role by role: every other cell in that matrix was a 200, a 403 or a
// 404, and this one was a server error.
//
// Two faults compounded:
//
//   1. `year` was never validated at all.
//   2. `month < 1 || month > 12` DOES NOT CATCH NaN. Every comparison with NaN
//      is false, so the guard passed it — and `Date.UTC(NaN, NaN, 1)` is an
//      Invalid Date, which Prisma rejects.
//
// The second is the interesting one. The check looks like a range check and is
// one, for every value except the one that actually arrives when a caller omits
// the parameter. `Number(undefined)` is NaN.
//
// Omitting them now means THIS MONTH, in the SCHOOL's timezone — a report pulled
// at 9pm in Lagos on the 1st must not be last month's because the server has not
// turned over yet.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { StaffAttendanceService } from "../../src/hr/attendance.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "S", userId: "u-1", roles: ["hr_clerk"], permissions: ["hr.read"] };

function makeService(timezone = "Africa/Lagos") {
  const queried: Array<{ gte: Date; lt: Date }> = [];
  const tx = {
    staffAttendance: {
      findMany: jest.fn(async (a: { where: { date: { gte: Date; lt: Date } } }) => {
        queried.push(a.where.date);
        return [];
      }),
    },
    user: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const region = { forSchool: jest.fn(async () => ({ timezone })) };
  const svc = new StaffAttendanceService(db as never, { record: jest.fn() } as never, region as never);
  return { svc, queried };
}

describe("asking for the summary without saying which month", () => {
  it("answers with this month rather than a server error", async () => {
    const { svc, queried } = makeService();
    const out = await svc.summary(p);
    expect(queried).toHaveLength(1);
    expect(Number.isNaN(queried[0].gte.getTime())).toBe(false);
    expect(out.month).toBeGreaterThanOrEqual(1);
    expect(out.month).toBeLessThanOrEqual(12);
  });

  it("uses the SCHOOL's month, not the server's", async () => {
    // The documented rule everywhere else in this codebase: "today" is the
    // school's calendar day. A report is a month of those days.
    const { svc } = makeService("Pacific/Auckland");
    const out = await svc.summary(p);
    const school = new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
    expect(out.year).toBe(school.getFullYear());
    expect(out.month).toBe(school.getMonth() + 1);
  });

  it("reports back which month it actually answered for", async () => {
    // Otherwise a caller who omitted the parameters cannot tell what they got.
    const { svc } = makeService();
    const out = await svc.summary(p);
    expect(typeof out.year).toBe("number");
    expect(typeof out.month).toBe("number");
  });
});

describe("the NaN that the range check could not see", () => {
  it("is refused when it comes from an unparseable month", async () => {
    const { svc } = makeService();
    // `Number("banana")` — what a hand-typed query string produces.
    await expect(svc.summary(p, 2026, Number("banana"))).resolves.toBeDefined();
    // NaN is treated as "not given" and defaults, rather than reaching Prisma.
  });

  it("never builds an Invalid Date, whatever it is handed", async () => {
    const { svc, queried } = makeService();
    await svc.summary(p, Number("x"), Number("y"));
    expect(queried).toHaveLength(1);
    expect(Number.isNaN(queried[0].gte.getTime())).toBe(false);
    expect(Number.isNaN(queried[0].lt.getTime())).toBe(false);
  });

  it("still refuses a month that is a real number and out of range", async () => {
    const { svc } = makeService();
    await expect(svc.summary(p, 2026, 13)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.summary(p, 2026, 0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a year outside anything a school could mean", async () => {
    const { svc } = makeService();
    await expect(svc.summary(p, 12, 6)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.summary(p, 99999, 6)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a fractional month rather than flooring it", async () => {
    const { svc } = makeService();
    await expect(svc.summary(p, 2026, 6.5)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("a real month still works", () => {
  it("queries exactly that calendar month", async () => {
    const { svc, queried } = makeService();
    await svc.summary(p, 2026, 3);
    expect(queried[0].gte.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(queried[0].lt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("rolls the year over in December", async () => {
    const { svc, queried } = makeService();
    await svc.summary(p, 2026, 12);
    expect(queried[0].lt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
