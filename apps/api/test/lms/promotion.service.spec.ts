// =============================================================================
// PromotionService — end-of-session maker-checker unit tests
// =============================================================================
// Proves: staging defaults target to the source's nextClassId + students to ACTIVE
// enrollments and moves nothing; a DIFFERENT person must approve (SoD); approval
// marks source enrollments PROMOTED + creates target enrollments (idempotent);
// a final class (no next) GRADUATES instead; already-decided is rejected.

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PromotionService } from "../../src/lms/promotion.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

type Row = Record<string, unknown>;

function makeService(opts: {
  source?: Row | null;
  target?: Row | null;
  /** Additional classes that exist in the tenant (e.g. demotion destinations). */
  others?: Row[];
  activeEnrollments?: string[];
  batch?: Row | null;
  existingTargetEnrollments?: string[];
}) {
  const state: { batch: Row | null } = { batch: opts.batch ?? null };
  const enrollUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const enrollCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const existingTarget = opts.existingTargetEnrollments ?? [];
  const tx = {
    class: {
      findFirst: jest.fn((a: { where: { id: string } }) => {
        const all = [opts.source, opts.target, ...(opts.others ?? [])].filter(Boolean) as Row[];
        return Promise.resolve(all.find((c) => c.id === a.where.id) ?? null);
      }),
      // Used both to resolve display names and to validate demotion targets, so
      // it must only return classes that actually exist in this tenant.
      findMany: jest.fn((a?: { where?: { id?: { in?: string[] } } }) => {
        const all = [opts.source, opts.target, ...(opts.others ?? [])].filter(Boolean) as Row[];
        const wanted = a?.where?.id?.in;
        const rows = wanted ? all.filter((c) => wanted.includes(c.id as string)) : all;
        return Promise.resolve(rows.map((c) => ({ id: c.id, name: (c.name as string) ?? "C" })));
      }),
    },
    enrollment: {
      // stage() queries ACTIVE source enrollments; approve() queries existing target.
      findMany: jest.fn((a: { where?: { studentId?: unknown; status?: string } }) =>
        a.where?.studentId
          ? Promise.resolve(existingTarget.map((studentId) => ({ studentId })))
          : Promise.resolve((opts.activeEnrollments ?? []).map((studentId) => ({ studentId }))),
      ),
      count: jest.fn().mockResolvedValue(0),
      updateMany: enrollUpdateMany,
      createMany: enrollCreateMany,
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
  return { service: new PromotionService(db as never, audit as never), enrollUpdateMany, enrollCreateMany };
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
    const { service, enrollCreateMany } = makeService({
      source: { id: "c1", nextClassId: "c2" },
      target: { id: "c2" },
      activeEnrollments: ["s1", "s2", "s3"],
    });
    const res = await service.stage(p("maker"), { sourceClassId: "c1" });
    expect(res.targetClassId).toBe("c2");
    expect(res.studentCount).toBe(3);
    expect(enrollCreateMany).not.toHaveBeenCalled(); // nothing moved yet
  });

  it("blocks the initiator from approving (SoD)", async () => {
    const { service } = makeService({ batch: batch({ initiatedById: "maker" }) });
    await expect(service.approve(p("maker"), "pb1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a DIFFERENT approver moves enrollments (PROMOTED + new ACTIVE), idempotently", async () => {
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      batch: batch({ studentIds: ["s1", "s2"] }),
      existingTargetEnrollments: ["s2"], // s2 already in target -> not recreated
    });
    const res = await service.approve(p("approver"), "pb1");
    expect(res.status).toBe("APPROVED");
    expect(enrollUpdateMany).toHaveBeenCalledTimes(1); // one batched source update
    // only s1 (s2 already enrolled) gets a new target enrollment, in one createMany.
    expect(enrollCreateMany).toHaveBeenCalledTimes(1);
    expect(enrollCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ studentId: "s1", status: "ACTIVE" })] }),
    );
  });

  it("graduates students when the source has no next class (null target)", async () => {
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      batch: batch({ targetClassId: null, studentIds: ["s1"] }),
    });
    await service.approve(p("approver"), "pb1");
    expect(enrollUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "GRADUATED" } }),
    );
    expect(enrollCreateMany).not.toHaveBeenCalled();
  });

  it("refuses to approve an already-decided batch", async () => {
    const { service } = makeService({ batch: batch({ status: "APPROVED" }) });
    await expect(service.approve(p("approver"), "pb1")).rejects.toBeInstanceOf(ConflictException);
  });
});

// =============================================================================
// Per-student outcomes: PROMOTE (default) / RETAIN / DEMOTE
// =============================================================================
describe("PromotionService per-student outcomes", () => {
  const threeClasses = {
    source: { id: "c1", nextClassId: "c2", name: "JSS2" },
    target: { id: "c2", name: "JSS3" },
    others: [{ id: "c0", name: "JSS1" }],
  };

  it("fills PROMOTE for every student when no overrides are given", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1", "s2"] });
    const res = await service.stage(p("maker"), { sourceClassId: "c1" });
    expect(res.promoteCount).toBe(2);
    expect(res.retainCount).toBe(0);
    expect(res.demoteCount).toBe(0);
    expect(res.decisions.every((d) => d.outcome === "PROMOTE")).toBe(true);
  });

  it("records RETAIN and DEMOTE overrides alongside the promoted majority", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1", "s2", "s3"] });
    const res = await service.stage(p("maker"), {
      sourceClassId: "c1",
      decisions: [
        { studentId: "s2", outcome: "RETAIN", note: "Below pass mark" },
        { studentId: "s3", outcome: "DEMOTE", targetClassId: "c0" },
      ],
    });
    expect(res.promoteCount).toBe(1);
    expect(res.retainCount).toBe(1);
    expect(res.demoteCount).toBe(1);
    const s3 = res.decisions.find((d) => d.studentId === "s3");
    expect(s3?.targetClassId).toBe("c0");
    expect(s3?.targetClassName).toBe("JSS1"); // resolved for the approver
    expect(res.decisions.find((d) => d.studentId === "s2")?.note).toBe("Below pass mark");
  });

  it("rejects a DEMOTE with no destination class", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1"] });
    await expect(
      service.stage(p("maker"), { sourceClassId: "c1", decisions: [{ studentId: "s1", outcome: "DEMOTE" }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects demoting into the present class (that is a retention)", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1"] });
    await expect(
      service.stage(p("maker"), {
        sourceClassId: "c1",
        decisions: [{ studentId: "s1", outcome: "DEMOTE", targetClassId: "c1" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects demoting into the promotion target (that is a promotion)", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1"] });
    await expect(
      service.stage(p("maker"), {
        sourceClassId: "c1",
        decisions: [{ studentId: "s1", outcome: "DEMOTE", targetClassId: "c2" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a decision for a student who is not in the batch", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1"] });
    await expect(
      service.stage(p("maker"), { sourceClassId: "c1", decisions: [{ studentId: "ghost", outcome: "RETAIN" }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a demotion into a class that does not exist in this tenant", async () => {
    const { service } = makeService({ ...threeClasses, activeEnrollments: ["s1"] });
    await expect(
      service.stage(p("maker"), {
        sourceClassId: "c1",
        decisions: [{ studentId: "s1", outcome: "DEMOTE", targetClassId: "c-other-school" }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("approval: promotes some, leaves RETAINed enrollments untouched, moves DEMOTEd down", async () => {
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      ...threeClasses,
      batch: batch({
        studentIds: ["s1", "s2", "s3"],
        decisions: [
          { studentId: "s1", outcome: "PROMOTE", targetClassId: null },
          { studentId: "s2", outcome: "RETAIN", targetClassId: null },
          { studentId: "s3", outcome: "DEMOTE", targetClassId: "c0" },
        ],
      }),
    });
    const res = await service.approve(p("approver"), "pb1");
    expect(res.status).toBe("APPROVED");

    // Source enrollments: s1 -> PROMOTED, s3 -> DEMOTED. s2 is never touched.
    const updates = enrollUpdateMany.mock.calls.map((c) => c[0]);
    const promoted = updates.find((u) => u.data.status === "PROMOTED");
    const demoted = updates.find((u) => u.data.status === "DEMOTED");
    expect(promoted?.where.studentId.in).toEqual(["s1"]);
    expect(demoted?.where.studentId.in).toEqual(["s3"]);
    expect(updates.some((u) => (u.where.studentId.in as string[]).includes("s2"))).toBe(false);

    // New enrollments: s1 into the target, s3 into the demotion class.
    const creates = enrollCreateMany.mock.calls.map((c) => c[0].data).flat();
    expect(creates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ studentId: "s1", classId: "c2", status: "ACTIVE" }),
        expect.objectContaining({ studentId: "s3", classId: "c0", status: "ACTIVE" }),
      ]),
    );
    // s2 gets no new enrollment anywhere — they simply repeat the present class.
    expect(creates.some((c: Row) => c.studentId === "s2")).toBe(false);
  });

  it("approval of a RETAIN-only batch moves nothing at all", async () => {
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      ...threeClasses,
      batch: batch({
        studentIds: ["s1"],
        decisions: [{ studentId: "s1", outcome: "RETAIN", targetClassId: null }],
      }),
    });
    await service.approve(p("approver"), "pb1");
    expect(enrollUpdateMany).not.toHaveBeenCalled();
    expect(enrollCreateMany).not.toHaveBeenCalled();
  });

  it("legacy batches with no decisions still promote everyone (back-compat)", async () => {
    const { service, enrollUpdateMany } = makeService({
      ...threeClasses,
      batch: batch({ studentIds: ["s1", "s2"], decisions: null }),
    });
    const res = await service.approve(p("approver"), "pb1");
    expect(res.promoteCount).toBe(2);
    expect(enrollUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PROMOTED" } }),
    );
  });
});
