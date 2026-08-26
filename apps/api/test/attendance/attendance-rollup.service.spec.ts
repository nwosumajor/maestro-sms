// =============================================================================
// AttendanceRollupService — the invariant, not just the arithmetic
// =============================================================================
// The whole design rests on one property: only ENDED terms are rolled up, because
// AttendanceService locks registers in an ended term for everyone, so those records
// cannot change and a rollup of them cannot drift. Everything else follows from
// that — no cache invalidation, no staleness marker, no "refresh before reading".
//
// So the tests that matter are: it REFUSES a live term, and it reads the rollup
// only when the window is exactly an ended term.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AttendanceRollupService } from "../../src/attendance/attendance-rollup.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = { schoolId: "A", userId: "u1", roles: ["school_admin"], permissions: [] };

const mk = (tx: Record<string, unknown>) => {
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
  };
  // The nightly sweep needs a privileged client to list schools; these cases
  // drive one tenant directly, so it is absent — which is also the shape the
  // sweep must survive (it logs and returns zero rather than throwing).
  return new AttendanceRollupService(db as never, { record: jest.fn() } as never, { client: null } as never);
};

const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

describe("AttendanceRollupService.refreshTerm", () => {
  it("REFUSES a term that has not ended", async () => {
    // The invariant. Rolling up a live term produces a figure that is wrong by
    // tomorrow and carries nothing to say so.
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "Term 2", startDate: day(-30), endDate: day(+30) }) },
      attendanceTermRollup: { deleteMany: jest.fn() },
      $executeRaw: jest.fn(),
    };
    await expect(mk(tx).refreshTerm(staff, "t1")).rejects.toBeInstanceOf(BadRequestException);
    // And it does not touch anything on the way out.
    expect(tx.attendanceTermRollup.deleteMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("REPLACES an ended term's rows rather than adding to them", async () => {
    // A recompute must not leave rows for pupils since unenrolled from the class.
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "Term 1", startDate: day(-120), endDate: day(-30) }) },
      attendanceTermRollup: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
      $executeRaw: jest.fn().mockResolvedValue(31),
    };
    const out = await mk(tx).refreshTerm(staff, "t1");
    expect(out).toEqual({ rows: 31, termName: "Term 1" });
    expect(tx.attendanceTermRollup.deleteMany).toHaveBeenCalledWith({ where: { termId: "t1" } });
    // One statement, no rows crossing into Node.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("refuses a term with no dates, and 404s an unknown one", async () => {
    const noDates = {
      term: { findFirst: jest.fn().mockResolvedValue({ id: "t1", name: "T", startDate: null, endDate: null }) },
    };
    await expect(mk(noDates).refreshTerm(staff, "t1")).rejects.toBeInstanceOf(BadRequestException);
    const missing = { term: { findFirst: jest.fn().mockResolvedValue(null) } };
    await expect(mk(missing).refreshTerm(staff, "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("AttendanceRollupService.totalsFor", () => {
  const ended = { endDate: day(-30) };
  const live = { endDate: day(+30) };

  it("reads the ROLLUP for an ended term", async () => {
    const queryRaw = jest.fn();
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue(ended) },
      attendanceTermRollup: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { present: 90, absent: 6, late: 3, excused: 1, total: 100 } }),
        findFirst: jest.fn().mockResolvedValue({ id: "r1" }),
      },
      $queryRaw: queryRaw,
    };
    const out = await mk(tx).totalsFor(staff, { termId: "t1", from: day(-120), to: day(-30) });
    expect(out.source).toBe("rollup");
    // LATE counts as attending — the pupil was in school. EXCUSED does not.
    // 90 present + 3 late of 100 = 93.
    //
    // // GOTCHA: this asserted 94, with the comment "LATE and EXCUSED count as
    // attending — same rule as the report card". The card has never used that
    // rule; it has always been present + late. So the test PINNED the
    // divergence it described as agreement — the shape this repo has met before,
    // where a plausible-sounding belief is defended by an assertion.
    expect(out.ratePct).toBe(93);
    // The point of the rollup: the registers are never scanned.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("computes LIVE for the current term, even though a rollup could exist", async () => {
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue(live) },
      attendanceTermRollup: { aggregate: jest.fn(), findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ present: 40, absent: 5, late: 5, excused: 0, total: 50 }]),
    };
    const out = await mk(tx).totalsFor(staff, { termId: "t2", from: day(-30), to: day(0) });
    expect(out.source).toBe("live");
    expect(out.ratePct).toBe(90);
    // It must not even consult the rollup for a live term.
    expect(tx.attendanceTermRollup.aggregate).not.toHaveBeenCalled();
  });

  it("computes LIVE for an arbitrary date range", async () => {
    // A precomputed number that does not match the dates asked for is just a wrong
    // number delivered quickly.
    const tx = {
      term: { findFirst: jest.fn() },
      attendanceTermRollup: { aggregate: jest.fn(), findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ present: 8, absent: 2, late: 0, excused: 0, total: 10 }]),
    };
    const out = await mk(tx).totalsFor(staff, { termId: null, from: day(-14), to: day(0) });
    expect(out.source).toBe("live");
    expect(out.ratePct).toBe(80);
    expect(tx.term.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to LIVE when an ended term has not been rolled up yet", async () => {
    // Absence of a rollup must degrade to a correct slow answer, never to zero.
    const tx = {
      term: { findFirst: jest.fn().mockResolvedValue(ended) },
      attendanceTermRollup: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { present: null, absent: null, late: null, excused: null, total: null } }),
        findFirst: jest.fn().mockResolvedValue(null), // nothing computed for this term
      },
      $queryRaw: jest.fn().mockResolvedValue([{ present: 20, absent: 0, late: 0, excused: 0, total: 20 }]),
    };
    const out = await mk(tx).totalsFor(staff, { termId: "t1", from: day(-120), to: day(-30) });
    expect(out.source).toBe("live");
    expect(out.total).toBe(20);
  });

  it("reports null (not 0%) when a window has no registers at all", async () => {
    // 0% reads as "nobody attended"; null reads as "nothing recorded".
    const tx = {
      term: { findFirst: jest.fn() },
      attendanceTermRollup: { aggregate: jest.fn(), findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ present: 0, absent: 0, late: 0, excused: 0, total: 0 }]),
    };
    const out = await mk(tx).totalsFor(staff, { termId: null, from: day(-7), to: day(0) });
    expect(out.ratePct).toBeNull();
  });
});
