// =============================================================================
// A rollup that was built, consumed, and never populated
// =============================================================================
// AttendanceService reads `attendance_term_rollup` (`useRollup`) and falls
// through to the live path when it finds nothing — so the figures were always
// correct, and always computed the slow way. The only thing that WROTE a rollup
// was a manual endpoint no screen calls. On the live stack the table held
//
//     0 rollup rows      against      173,701 attendance records
//
// and the service's own comments described "the daily sweep" as though one
// existed. This is the shape where nothing is broken and nothing works: no
// error, no wrong number, just a page that quietly takes the long route
// forever.
//
// What it costs, measured on that data: the whole-school term aggregate the
// rollup replaces runs in 93 ms, and it is bounded by the school's LIFETIME
// rather than its size — every term a school keeps makes it slower, on a page
// senior staff open constantly.
//
// The invariant that makes the sweep safe is the one the service was designed
// around: ONLY ENDED TERMS are rolled up, and an ended term's registers cannot
// change (the term lock refuses every write dated before the current term's
// start). There is nothing to invalidate.
// =============================================================================

import { AttendanceRollupService } from "../../src/attendance/attendance-rollup.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(opts: {
  schools?: Array<{ id: string }>;
  actorFor?: (schoolId: string) => { userId: string } | null;
  refresh?: jest.Mock;
  client?: unknown;
}) {
  const schools = opts.schools ?? [{ id: "s1" }, { id: "s2" }];
  const client =
    opts.client === undefined
      ? {
          school: { findMany: jest.fn().mockResolvedValue(schools) },
          userRole: {
            findFirst: jest.fn(({ where }: { where: { schoolId: string } }) =>
              Promise.resolve(opts.actorFor ? opts.actorFor(where.schoolId) : { userId: `admin-${where.schoolId}` }),
            ),
          },
        }
      : opts.client;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn({} as TenantTx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn({} as TenantTx),
  };
  const svc = new AttendanceRollupService(db as never, { record: jest.fn() } as never, {
    client,
  } as never);
  const refresh = opts.refresh ?? jest.fn().mockResolvedValue({ refreshed: ["Term 1"], skipped: 0 });
  (svc as unknown as { refreshEndedTerms: unknown }).refreshEndedTerms = refresh;
  return { svc, refresh, client: client as { school: { findMany: jest.Mock }; userRole: { findFirst: jest.Mock } } };
}

describe("the nightly rollup sweep", () => {
  it("rolls up every school and reports what it did", async () => {
    const { svc, refresh } = makeService({});
    await expect(svc.runSweep()).resolves.toEqual({ schools: 2, terms: 2, skipped: 0 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("runs each school's work under that school's own tenant scope", async () => {
    // The school list is a privileged cross-tenant read; the WRITING is not.
    const { svc, refresh } = makeService({});
    await svc.runSweep();
    expect(refresh.mock.calls.map((c) => (c[0] as Principal).schoolId)).toEqual(["s1", "s2"]);
    expect(refresh.mock.calls[0][0]).toMatchObject({ userId: "admin-s1" });
  });

  it("skips a school with no management user rather than writing as SYSTEM", async () => {
    // audit_log.actorId is a non-null FK to User; the all-zero SYSTEM id would
    // violate it, and a rollup nobody can be held to is not worth the row.
    const { svc, refresh } = makeService({ actorFor: (id) => (id === "s1" ? { userId: "a1" } : null) });
    await expect(svc.runSweep()).resolves.toEqual({ schools: 1, terms: 1, skipped: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("one school's failure never stops the rest", async () => {
    // Worst case for a failed school is that its figures stay LIVE — which is
    // exactly what they were before this sweep existed.
    const refresh = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ refreshed: ["Term 2"], skipped: 0 });
    const { svc } = makeService({ refresh });
    await expect(svc.runSweep()).resolves.toEqual({ schools: 1, terms: 1, skipped: 1 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all without a privileged database", async () => {
    // Same posture as retention and dunning: no privileged URL means the sweep
    // is disabled, not half-run.
    const { svc, refresh } = makeService({ client: null });
    await expect(svc.runSweep()).resolves.toEqual({ schools: 0, terms: 0, skipped: 0 });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never touches the platform organisation", async () => {
    // It has no pupils and no registers; sweeping it is work that can only
    // produce an empty rollup.
    const { svc, client } = makeService({});
    await svc.runSweep();
    expect(client.school.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isPlatform: false } }),
    );
  });

  it("counts schools it actually rolled up, not schools it visited", async () => {
    // "2 schools, 0 terms" and "0 schools" are different facts, and a sweep that
    // cannot tell them apart is how this one went unnoticed for so long.
    const refresh = jest.fn().mockResolvedValue({ refreshed: [], skipped: 0 });
    const { svc } = makeService({ refresh });
    await expect(svc.runSweep()).resolves.toEqual({ schools: 0, terms: 0, skipped: 0 });
  });
});
