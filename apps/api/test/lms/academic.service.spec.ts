// =============================================================================
// AcademicService — calendar correctness (session-sync, quick-create, validation)
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { AcademicService } from "../../src/lms/academic.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const p: Principal = { schoolId: "A", userId: "u1", roles: ["principal"], permissions: ["academic.manage"] };

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new AcademicService(db as never, audit as never), audit };
}

describe("AcademicService.setCurrentTerm", () => {
  it("makes the term's SESSION current too (no pointer outside the current session)", async () => {
    const sessionUpdate = jest.fn().mockResolvedValue({});
    const tx = {
      term: {
        // Dated: a term without both dates can no longer BE made current.
        findFirst: jest.fn().mockResolvedValue({ id: "t2", sessionId: "s9", name: "Second Term", startDate: new Date("2027-01-05"), endDate: new Date("2027-04-01") }),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      academicSession: {
        updateMany: jest.fn().mockResolvedValue({}),
        update: sessionUpdate,
      },
    } as unknown as TenantTx;
    await svc(tx).service.setCurrentTerm(p, "t2");
    // The session pointer is moved to the term's own session.
    expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s9" }, data: { isCurrent: true } }));
  });
});

describe("AcademicService.createStandardSession", () => {
  it("creates the session plus exactly three sequenced terms in one action", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 3 });
    const tx = {
      academicSession: {
        create: jest.fn().mockResolvedValue({ id: "s1" }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "s1", name: "2025/2026", isCurrent: false, startDate: new Date(), endDate: new Date() }),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      term: {
        createMany,
        findFirst: jest.fn().mockResolvedValue({ id: "t1" }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as TenantTx;
    await svc(tx).service.createStandardSession(p, { name: "2025/2026", yearStart: "2025-09-08" });
    const rows = (createMany.mock.calls[0][0] as { data: unknown[] }).data;
    expect(rows).toHaveLength(3);
    expect((rows as Array<{ sequence: number }>).map((r) => r.sequence)).toEqual([1, 2, 3]);
  });
});

describe("AcademicService.setCurrentToToday", () => {
  it("400s when no term's dates contain today", async () => {
    const tx = { term: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as TenantTx;
    await expect(svc(tx).service.setCurrentToToday(p)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("AcademicService.addTerm validation", () => {
  it("rejects a term overlapping a sibling and never writes it", async () => {
    const create = jest.fn();
    const tx = {
      academicSession: { findFirst: jest.fn().mockResolvedValue({ id: "s1", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") }) },
      term: {
        findMany: jest.fn().mockResolvedValue([
          { id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: new Date("2025-09-08"), endDate: new Date("2025-12-12") },
        ]),
        create,
      },
    } as unknown as TenantTx;
    await expect(
      svc(tx).service.addTerm(p, "s1", { name: "Second Term", sequence: 2, startDate: "2025-12-01", endDate: "2026-03-01" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("AcademicService.setCurrentTerm refuses a dateless term", () => {
  // Promoted from a warning to a refusal: this is the one state where failing
  // open costs the past-term register lock, so it is blocked at the point the
  // term becomes current rather than reported afterwards.
  const withTerm = (term: Record<string, unknown>) =>
    ({
      term: {
        findFirst: jest.fn().mockResolvedValue(term),
        updateMany: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      academicSession: { updateMany: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    }) as unknown as TenantTx;

  it("refuses when BOTH dates are missing, and says why", async () => {
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: null });
    const { service } = svc(tx);
    await expect(service.setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1"))
      .rejects.toThrow(/register lock is off/i);
  });

  it("refuses when only the START date is missing", async () => {
    // The start date is the one the lock reads, so this is the dangerous half.
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: new Date("2026-12-15") });
    const { service } = svc(tx);
    await expect(service.setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1"))
      .rejects.toThrow(/needs start date/i);
  });

  it("does NOT write anything when it refuses", async () => {
    // A refusal that had already cleared the previous current term would leave
    // the school with no current term at all — worse than where it started.
    const tx = withTerm({ id: "t1", sessionId: "s1", name: "First Term", startDate: null, endDate: null });
    const { service } = svc(tx);
    await service
      .setCurrentTerm({ schoolId: "s", userId: "u", roles: [], permissions: [] } as never, "t1")
      .catch(() => undefined);
    expect((tx.term.updateMany as jest.Mock)).not.toHaveBeenCalled();
    expect((tx.term.update as jest.Mock)).not.toHaveBeenCalled();
  });
});
