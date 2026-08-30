// =============================================================================
// ExemptionService — who may grant an accommodation, and to whom
// =============================================================================
// This writes a record about a child's disability accommodation, so the two
// properties worth pinning are the scope (a teacher reaches their OWN pupils and
// nobody else's, as a 404) and the audit (every grant, revoke and read is
// logged — Golden Rule #5).
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { ExemptionService } from "../../src/integrity/exemption.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const principal = (roles: string[], userId = "teacher-1") =>
  ({ userId, schoolId: "s1", roles, permissions: [] }) as unknown as Principal;

interface Fixture {
  /** classes this teacher teaches */
  taught?: string[];
  /** studentId -> classes they are enrolled in */
  enrolled?: Record<string, string[]>;
  exemptions?: Array<Record<string, unknown>>;
}

function harness(fx: Fixture = {}) {
  const taught = fx.taught ?? ["c1"];
  const enrolled = fx.enrolled ?? { "pupil-1": ["c1"] };
  const rows: Array<Record<string, unknown>> = [...(fx.exemptions ?? [])];
  const audits: Array<Record<string, unknown>> = [];
  let created: Record<string, unknown> | null = null;
  let updated: Record<string, unknown> | null = null;

  const tx = {
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id.startsWith("outsider") ? null : { id: where.id }),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, name: `Name ${id}` }))),
      ),
    },
    // One definition of who teaches a class (common/teaches.ts) reads the
    // class SUPERVISOR and the subject offerings too — every real TenantTx
    // answers all three.
    // The classes this teacher RUNS — the fixture's own `taught` list, which
    // the retired join row used to carry.
    // Honours the where for the same reason the enrolment stub below does.
    class: {
      findMany: jest.fn(({ where }: { where?: { supervisorId?: string } } = {}) =>
        Promise.resolve(where?.supervisorId ? taught.map((id) => ({ id })) : []),
      ),
    },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: {
      // Honours the where — a mock that ignored it would pass every scoping test
      // by accident, which is the trap this suite exists to avoid.
      findFirst: jest.fn(({ where }: { where: { studentId: string; classId: { in: string[] } } }) => {
        const mine = enrolled[where.studentId] ?? [];
        return Promise.resolve(mine.some((c) => where.classId.in.includes(c)) ? { id: "e1" } : null);
      }),
      findMany: jest.fn(({ where }: { where: { classId: { in: string[] } } }) =>
        Promise.resolve(
          Object.entries(enrolled)
            .filter(([, cs]) => cs.some((c) => where.classId.in.includes(c)))
            .map(([studentId]) => ({ studentId })),
        ),
      ),
    },
    assessment: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "missing" ? null : { id: where.id, title: "Test" }),
      ),
    },
    studentIntegrityExemption: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return Promise.resolve(rows.find((r) => r.id === where.id) ?? null);
        return Promise.resolve(
          rows.find(
            (r) =>
              r.studentId === where.studentId &&
              r.assessmentId === (where.assessmentId ?? null) &&
              r.revokedAt === null,
          ) ?? null,
        );
      }),
      findMany: jest.fn(() => Promise.resolve(rows)),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created = { id: "new-1", revokedAt: null, revokedById: null, createdAt: new Date(), ...data };
        rows.push(created);
        return Promise.resolve(created);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        updated = row;
        return Promise.resolve(row);
      }),
    },
  } as unknown as TenantTx;

  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn((e: Record<string, unknown>) => { audits.push(e); return Promise.resolve(); }) };
  return {
    svc: new ExemptionService(db as never, audit as never),
    tx,
    audits,
    get created() { return created; },
    get updated() { return updated; },
  };
}

describe("ExemptionService — scope", () => {
  it("a teacher may exempt a pupil in a class they teach", async () => {
    const h = harness();
    const dto = await h.svc.grant(principal(["teacher"]), { studentId: "pupil-1", reason: "screen reader" });
    expect(dto.active).toBe(true);
    expect(dto.assessmentId).toBeNull(); // global by default
    expect(h.created).toMatchObject({ studentId: "pupil-1", reason: "screen reader", grantedById: "teacher-1" });
  });

  it("a teacher may NOT exempt a pupil they do not teach — 404, not 403", async () => {
    // 403 would confirm the pupil exists in the school. One teacher must not be
    // able to enumerate another's roster.
    const h = harness({ taught: ["c1"], enrolled: { "pupil-9": ["c2"] } });
    await expect(
      h.svc.grant(principal(["teacher"]), { studentId: "pupil-9", reason: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.created).toBeNull();
  });

  it("a teacher who teaches NOTHING reaches nobody", async () => {
    const h = harness({ taught: [] });
    await expect(
      h.svc.grant(principal(["teacher"]), { studentId: "pupil-1", reason: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("school_admin and principal act school-wide", async () => {
    for (const role of ["school_admin", "principal"]) {
      const h = harness({ taught: [], enrolled: {} });
      const dto = await h.svc.grant(principal([role], "admin-1"), { studentId: "pupil-7", reason: "note taker" });
      expect(dto.studentId).toBe("pupil-7");
    }
  });

  it("super_admin gets NO standing scope", async () => {
    // The posture: a platform account has no standing reach into a school's data.
    const h = harness({ taught: [], enrolled: {} });
    await expect(
      h.svc.grant(principal(["super_admin"], "op-1"), { studentId: "pupil-1", reason: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a pupil outside the tenant is not found (RLS already hid them)", async () => {
    const h = harness();
    await expect(
      h.svc.grant(principal(["school_admin"]), { studentId: "outsider-1", reason: "x" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ExemptionService — behaviour", () => {
  it("granting twice for the same scope does not create a second active row", async () => {
    // Two active rows would mean revoking one leaves the pupil still exempt.
    const h = harness();
    const first = await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "a" });
    const again = await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "b" });
    expect(again.id).toBe(first.id);
    expect(h.tx.studentIntegrityExemption.create).toHaveBeenCalledTimes(1);
  });

  it("a global and a per-assessment accommodation can coexist", async () => {
    const h = harness();
    await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "a" });
    await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", assessmentId: "a1", reason: "b" });
    expect(h.tx.studentIntegrityExemption.create).toHaveBeenCalledTimes(2);
  });

  it("revoking SOFT-deletes — the row is kept with who and when", async () => {
    const h = harness();
    const g = await h.svc.grant(principal(["school_admin"], "admin-1"), { studentId: "pupil-1", reason: "a" });
    const r = await h.svc.revoke(principal(["school_admin"], "admin-2"), g.id, "no longer needed");
    expect(r.active).toBe(false);
    expect(h.updated).toMatchObject({ revokedById: "admin-2" });
    expect((h.updated as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
  });

  it("a reason is required", async () => {
    const h = harness();
    await expect(
      h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "   " }),
    ).rejects.toThrow(/reason/i);
  });

  it("a non-existent assessment is refused", async () => {
    const h = harness();
    await expect(
      h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", assessmentId: "missing", reason: "a" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ExemptionService — audit (Golden Rule #5)", () => {
  it("logs the grant, with the reason", async () => {
    const h = harness();
    await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "screen reader" });
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "integrity.exemption.grant",
        metadata: expect.objectContaining({ studentId: "pupil-1", scope: "global", reason: "screen reader" }),
      }),
    ]);
  });

  it("logs the revoke", async () => {
    const h = harness();
    const g = await h.svc.grant(principal(["school_admin"]), { studentId: "pupil-1", reason: "a" });
    await h.svc.revoke(principal(["school_admin"]), g.id);
    expect(h.audits.map((a) => a.action)).toContain("integrity.exemption.revoke");
  });

  it("logs the READ, and does NOT copy the reason text into the log", async () => {
    // Who has an accommodation is sensitive, so the read is logged. The reason
    // is the most sensitive part and is already stored on the row — repeating it
    // in the audit on every page view would spread it for no benefit.
    const h = harness({ exemptions: [
      { id: "x1", studentId: "pupil-1", assessmentId: null, reason: "cerebral palsy", grantedById: "t", revokedAt: null, revokedById: null, createdAt: new Date() },
    ] });
    await h.svc.list(principal(["school_admin"]));
    const read = h.audits.find((a) => a.action === "integrity.exemption.read")!;
    expect(read).toBeDefined();
    expect(JSON.stringify(read)).not.toContain("cerebral palsy");
  });

  it("a teacher's list is narrowed to their own pupils", async () => {
    const h = harness({ taught: ["c1"], enrolled: { "pupil-1": ["c1"], "pupil-9": ["c2"] } });
    await h.svc.list(principal(["teacher"]));
    const call = (h.tx.studentIntegrityExemption.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where.studentId).toEqual({ in: ["pupil-1"] });
  });

  it("a teacher with no classes gets an empty list and never queries", async () => {
    const h = harness({ taught: [] });
    await expect(h.svc.list(principal(["teacher"]))).resolves.toEqual([]);
    expect(h.tx.studentIntegrityExemption.findMany).not.toHaveBeenCalled();
  });
});
