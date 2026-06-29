// =============================================================================
// PromotionService — end-of-session maker-checker unit tests
// =============================================================================
// Proves: staging defaults target to the source's nextClassId + students to ACTIVE
// enrollments and moves nothing; a DIFFERENT person must approve (SoD); approval
// marks source enrollments PROMOTED + creates target enrollments (idempotent);
// a final class (no next) GRADUATES instead; already-decided is rejected.

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { PromotionService } from "../../src/lms/promotion.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function makeService(opts: {
  source?: Row | null;
  target?: Row | null;
  activeEnrollments?: string[];
  batch?: Row | null;
  existingTargetEnrollments?: string[];
}) {
  const state: { batch: Row | null } = { batch: opts.batch ?? null };
  const enrollUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const enrollCreate = jest.fn().mockResolvedValue({ id: "en" });
  const existingTarget = new Set(opts.existingTargetEnrollments ?? []);
  const tx = {
    class: {
      findFirst: jest.fn((a: { where: { id: string } }) => {
        if (opts.source && a.where.id === opts.source.id) return Promise.resolve(opts.source);
        if (opts.target && a.where.id === opts.target.id) return Promise.resolve(opts.target);
        return Promise.resolve(null);
      }),
      findMany: jest.fn().mockResolvedValue(
        [opts.source, opts.target].filter(Boolean).map((c) => ({ id: (c as Row).id, name: "C" })),
      ),
    },
    enrollment: {
      findMany: jest.fn().mockResolvedValue((opts.activeEnrollments ?? []).map((studentId) => ({ studentId }))),
      findFirst: jest.fn((a: { where: { studentId: string } }) =>
        Promise.resolve(existingTarget.has(a.where.studentId) ? { id: "exists" } : null),
      ),
      updateMany: enrollUpdateMany,
      create: enrollCreate,
    },
    promotionBatch: {
      create: jest.fn((a: { data: Row }) => Promise.resolve({ id: "pb1", ...a.data })),
      findFirst: jest.fn(() => Promise.resolve(state.batch)),
      update: jest.fn((a: { data: Row }) => {
        state.batch = { ...(state.batch ?? {}), ...a.data };
        return Promise.resolve(state.batch);
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new PromotionService(db as never, audit as never), enrollUpdateMany, enrollCreate };
}

const p = (userId: string): Principal => ({ schoolId: "A", userId, roles: ["school_admin"], permissions: [] });
const batch = (over: Row = {}): Row => ({
  id: "pb1",
  status: "PENDING",
  initiatedById: "maker",
  sourceClassId: "c1",
  targetClassId: "c2",
  studentIds: ["s1", "s2"],
  ...over,
});

describe("PromotionService maker-checker", () => {
  it("stage defaults target to nextClassId and students to ACTIVE enrollments", async () => {
    const { service, enrollCreate } = makeService({
      source: { id: "c1", nextClassId: "c2" },
      target: { id: "c2" },
      activeEnrollments: ["s1", "s2", "s3"],
    });
    const res = await service.stage(p("maker"), { sourceClassId: "c1" });
    expect(res.targetClassId).toBe("c2");
    expect(res.studentCount).toBe(3);
    expect(enrollCreate).not.toHaveBeenCalled(); // nothing moved yet
  });

  it("blocks the initiator from approving (SoD)", async () => {
    const { service } = makeService({ batch: batch({ initiatedById: "maker" }) });
    await expect(service.approve(p("maker"), "pb1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a DIFFERENT approver moves enrollments (PROMOTED + new ACTIVE), idempotently", async () => {
    const { service, enrollUpdateMany, enrollCreate } = makeService({
      batch: batch({ studentIds: ["s1", "s2"] }),
      existingTargetEnrollments: ["s2"], // s2 already in target -> not recreated
    });
    const res = await service.approve(p("approver"), "pb1");
    expect(res.status).toBe("APPROVED");
    expect(enrollUpdateMany).toHaveBeenCalledTimes(2); // both source enrollments marked
    expect(enrollCreate).toHaveBeenCalledTimes(1); // only s1 gets a new target enrollment
  });

  it("graduates students when the source has no next class (null target)", async () => {
    const { service, enrollUpdateMany, enrollCreate } = makeService({
      batch: batch({ targetClassId: null, studentIds: ["s1"] }),
    });
    await service.approve(p("approver"), "pb1");
    expect(enrollUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "GRADUATED" } }),
    );
    expect(enrollCreate).not.toHaveBeenCalled();
  });

  it("refuses to approve an already-decided batch", async () => {
    const { service } = makeService({ batch: batch({ status: "APPROVED" }) });
    await expect(service.approve(p("approver"), "pb1")).rejects.toBeInstanceOf(ConflictException);
  });
});
