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
  /** Rows that already exist in the DESTINATION class. A bare string means an
   *  ACTIVE one; `{ studentId, status }` models a CLOSED row, which is what a
   *  pupil returning to a class they have been in before actually has. The stub
   *  omitted `status` entirely while the service selects it — a double that did
   *  not model the contract, and the reason the demotion defect was invisible
   *  to this suite. */
  existingTargetEnrollments?: Array<string | { studentId: string; status: string }>;
  /** The school's current term, or null when none is set. */
  currentTerm?: { id: string } | null;
  /** classId -> capacity, for the overflow guard. */
  capacityOf?: Record<string, number>;
  /** How many pupils the destination already holds. */
  activeInTarget?: number;
}) {
  const state: { batch: Row | null } = { batch: opts.batch ?? null };
  const enrollUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const enrollCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const existingTarget = (opts.existingTargetEnrollments ?? []).map((e) =>
    typeof e === "string" ? { studentId: e, status: "ACTIVE" } : e,
  );
  const tx = {
    // The capacity guard locks the class row before counting. A double missing a
    // method the real client always has fails as a TypeError, which reads as a
    // code fault rather than a gap in the stub.
    $executeRaw: jest.fn().mockResolvedValue(0),
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: {
      findFirst: jest.fn((a: { where: { id: string } }) => {
        const all = [opts.source, opts.target, ...(opts.others ?? [])].filter(Boolean) as Row[];
        const found = all.find((c) => c.id === a.where.id) ?? null;
        const cap = opts.capacityOf?.[a.where.id];
        return Promise.resolve(found && cap != null ? { ...found, capacity: cap } : found);
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
          ? Promise.resolve(existingTarget)
          : Promise.resolve((opts.activeEnrollments ?? []).map((studentId) => ({ studentId }))),
      ),
      count: jest.fn().mockResolvedValue(opts.activeInTarget ?? 0),
      updateMany: enrollUpdateMany,
      createMany: enrollCreateMany,
    },
    term: {
      findFirst: jest.fn(() => Promise.resolve(opts.currentTerm === undefined ? { id: "t3" } : opts.currentTerm)),
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
  const created = tx.promotionBatch.create as jest.Mock;
  return { service: new PromotionService(db as never, audit as never), enrollUpdateMany, enrollCreateMany, created };
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

  it("puts a pupil BACK on the roll of a class they have been in before", async () => {
    // THE NORMAL SHAPE OF A DEMOTION: you demote a pupil back into the class
    // they came from, so they already have a row for it — a CLOSED one.
    //
    // `enrollInto` skipped anyone with any row for the destination, whatever its
    // status, to stay idempotent on a re-approval. Measured over five simulated
    // years: a pupil demoted from JSS 3 into the JSS 2 they had left the year
    // before ended with JSS 1 PROMOTED, JSS 2 PROMOTED, JSS 3 DEMOTED and NO
    // ACTIVE ENROLMENT ANYWHERE — off every register, out of every class list,
    // with no class for a report card, and uncounted in the billing seats.
    //
    // @@unique([classId, studentId]) is one row per pupil per class, so the
    // closed row must be REACTIVATED rather than a second one inserted.
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      ...threeClasses,
      existingTargetEnrollments: [{ studentId: "s3", status: "PROMOTED" }],
      batch: batch({
        studentIds: ["s3"],
        decisions: [{ studentId: "s3", outcome: "DEMOTE", targetClassId: "c0" }],
      }),
    });
    await service.approve(p("approver"), "pb1");

    const updates = enrollUpdateMany.mock.calls.map((c) => c[0]);
    // The row in the destination is put back to ACTIVE...
    const back = updates.find((u) => u.data.status === "ACTIVE" && u.where.classId === "c0");
    expect(back).toBeTruthy();
    expect(back?.where.studentId.in).toEqual(["s3"]);
    // ...and never duplicated, because the pair is unique.
    const creates = enrollCreateMany.mock.calls.map((c) => c[0].data).flat();
    expect(creates.some((c: Row) => c.studentId === "s3" && c.classId === "c0")).toBe(false);
  });

  it("leaves a pupil who is ALREADY ACTIVE in the destination alone", async () => {
    // The case the original skip was written for, and it still holds: a
    // re-approval must not rewrite a row that is already right.
    const { service, enrollUpdateMany, enrollCreateMany } = makeService({
      ...threeClasses,
      existingTargetEnrollments: ["s1"],
      batch: batch({
        studentIds: ["s1"],
        decisions: [{ studentId: "s1", outcome: "PROMOTE", targetClassId: null }],
      }),
    });
    await service.approve(p("approver"), "pb1");
    const creates = enrollCreateMany.mock.calls.map((c) => c[0].data).flat();
    expect(creates.some((c: Row) => c.studentId === "s1" && c.classId === "c2")).toBe(false);
    const reactivations = enrollUpdateMany.mock.calls
      .map((c) => c[0])
      .filter((u) => u.data.status === "ACTIVE" && u.where.classId === "c2");
    expect(reactivations).toHaveLength(0);
  });

  it("counts a reactivated pupil against the destination's capacity", async () => {
    // A place is a place. Counting only the INSERTS would let a demotion
    // overfill exactly the class this guard exists to protect.
    const { service } = makeService({
      ...threeClasses,
      capacityOf: { c0: 1 },
      activeInTarget: 1,
      existingTargetEnrollments: [{ studentId: "s3", status: "PROMOTED" }],
      batch: batch({
        studentIds: ["s3"],
        decisions: [{ studentId: "s3", outcome: "DEMOTE", targetClassId: "c0" }],
      }),
    });
    await expect(service.approve(p("approver"), "pb1")).rejects.toBeInstanceOf(ConflictException);
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

// =============================================================================
// WHEN the decision was taken
// =============================================================================
// `promotion_batch.termId` had existed since the table was created and nothing
// had ever written it. That was invisible while nothing read it — and became a
// defect the moment the report card tried to print "PROMOTED TO JSS2" beside the
// final term's marks: the lookup is by term, no batch carried one, and the line
// silently never appeared on any card. A column nobody writes is not a feature.
describe("the term a promotion belongs to", () => {
  it("is stamped with the term that is current when it is staged", async () => {
    const { service, created } = makeService({
      source: { id: "c1", nextClassId: "c2" },
      target: { id: "c2" },
      activeEnrollments: ["s1"],
      currentTerm: { id: "t3" },
    });
    await service.stage(p("maker"), { sourceClassId: "c1" });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ termId: "t3" }) }));
  });

  it("is null when the school has set no current term", async () => {
    // The report card then prints no promotion line at all — the right way to
    // fail for a claim about a child's year.
    const { service, created } = makeService({
      source: { id: "c1", nextClassId: "c2" },
      target: { id: "c2" },
      activeEnrollments: ["s1"],
      currentTerm: null,
    });
    await service.stage(p("maker"), { sourceClassId: "c1" });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ termId: null }) }));
  });
});
