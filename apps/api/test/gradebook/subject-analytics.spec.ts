// =============================================================================
// Subject performance: a teacher sees their own, leadership sees the school's
// =============================================================================
// The question this answers is "how did my class do in my subject, and where did
// they lose it" — and, for a head, the same across every subject at once.
//
// Built out of what already decides these things, so nothing can drift:
//
//   * `classSubjectTeacher` IS the definition of "the subjects I teach". It
//     already decides who may GRADE a class-subject, so what a teacher may
//     analyse cannot disagree with what they may mark.
//   * `READ_WIDE_ROLES` is already this service's answer to "who may read any
//     class's marks" (principal, head_teacher, school_admin, board,
//     junior_admin) — so leadership needs no new permission and no seed change.
//
// The route is gated on the coarse `grade.read`, which teachers, leadership,
// parents and pupils all hold, and the SERVICE narrows. That ordering is the
// lesson from three fixes in this campaign: a route gated on one party's
// permission silently locks out the others.
//
// The pair filter is the subtle part. A teacher who teaches Maths in JSS1 and
// English in JSS2 must see exactly those two class-subjects — not the Cartesian
// product of their classes and their subjects, which would hand them a
// colleague's English marks in JSS1.
// =============================================================================

import { TermResultService } from "../../src/gradebook/term-result.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = {
  schoolId: "S",
  userId: "teach-1",
  roles: ["teacher"],
  permissions: ["grade.read", "grade.write"],
};
const principal: Principal = { schoolId: "S", userId: "head-1", roles: ["principal"], permissions: ["grade.read"] };
const headTeacher: Principal = { schoolId: "S", userId: "ht-1", roles: ["head_teacher"], permissions: ["grade.read"] };
const parent: Principal = { schoolId: "S", userId: "par-1", roles: ["parent"], permissions: ["grade.read"] };

function makeService(opts: { offerings?: Array<{ classId: string; subjectId: string }> } = {}) {
  const { offerings = [{ classId: "c-1", subjectId: "s-maths" }] } = opts;
  let captured: { sql: string; values: unknown[] } | null = null;
  const tx = {
    classSubjectTeacher: { findMany: jest.fn(async () => offerings) },
    $queryRaw: jest.fn(async (q: { sql?: string; strings?: string[]; values?: unknown[] }) => {
      captured = { sql: (q.sql ?? (q.strings ?? []).join("?")) as string, values: q.values ?? [] };
      return [
        {
          classId: "c-1",
          subjectId: "s-maths",
          className: "JSS 1",
          subjectName: "Mathematics",
          entered: 30,
          published: 12,
          averageTotal: 58.4,
          highest: 91,
          lowest: 12,
          avgExam: 31.2,
          avgMidterm: 12.5,
          avgAssignment: 9.1,
          avgClassNote: 5.6,
          band_A: 3,
          band_B: 8,
          band_C: 9,
          band_D: 5,
          band_E: 2,
          band_F: 3,
        },
      ];
    }),
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const service = new TermResultService(
    db as never,
    { record: jest.fn() } as never,
    {} as never,
    { onFinalized: jest.fn() } as never,
    { academicInTx: async () => ({ grading: null }) } as never,
  );
  return { service, tx, sqlOf: () => captured };
}

describe("who sees which subjects", () => {
  it("a teacher is scoped to the class-subjects they teach", async () => {
    const { service, tx } = makeService();
    const out = await service.subjectAnalytics(teacher, { termId: "t-1" });
    expect(out.scope).toBe("teaching");
    expect(tx.classSubjectTeacher.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teacherId: "teach-1" } }),
    );
  });

  it("a principal sees the school's, with no offering lookup at all", async () => {
    const { service, tx } = makeService();
    const out = await service.subjectAnalytics(principal, { termId: "t-1" });
    expect(out.scope).toBe("school");
    expect(tx.classSubjectTeacher.findMany).not.toHaveBeenCalled();
  });

  it("a HEAD TEACHER sees the school's too", async () => {
    // They are a stage-1 approver on the publish chain — reading the numbers
    // they are asked to approve is the whole point.
    const { service } = makeService();
    expect((await service.subjectAnalytics(headTeacher, { termId: "t-1" })).scope).toBe("school");
  });

  it("a parent gets an empty result, not a refusal", async () => {
    // They hold grade.read, so the coarse gate lets them through; their teaching
    // scope is genuinely empty, and an empty list discloses nothing.
    const { service, tx } = makeService({ offerings: [] });
    const out = await service.subjectAnalytics(parent, { termId: "t-1" });
    expect(out.rows).toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("the pair filter", () => {
  it("matches (class, subject) PAIRS, never the cross product", async () => {
    // Maths in JSS1 and English in JSS2 must not yield English in JSS1.
    const { service, sqlOf } = makeService({
      offerings: [
        { classId: "c-1", subjectId: "s-maths" },
        { classId: "c-2", subjectId: "s-english" },
      ],
    });
    await service.subjectAnalytics(teacher, { termId: "t-1" });
    const sql = sqlOf()?.sql ?? "";
    expect(sql).toMatch(/\("classId", sr\."subjectId"\) IN|\(sr\."classId", sr\."subjectId"\) IN/);
    // Both ids of BOTH pairs are bound.
    const values = (sqlOf()?.values ?? []).map(String);
    for (const v of ["c-1", "s-maths", "c-2", "s-english"]) expect(values).toContain(v);
  });

  it("adds no pair filter for leadership", async () => {
    const { service, sqlOf } = makeService();
    await service.subjectAnalytics(principal, { termId: "t-1" });
    expect(sqlOf()?.sql ?? "").not.toMatch(/IN \(\(/);
  });
});

describe("the numbers", () => {
  it("reports the component averages, not just the total", async () => {
    // The actionable part: an exam mean of 31/60 beside an assignment mean of
    // 9.1/10 says where the class actually lost the marks.
    const { service } = makeService();
    const row = (await service.subjectAnalytics(teacher, { termId: "t-1" })).rows[0];
    expect(row.components).toEqual({ exam: 31.2, midterm: 12.5, assignment: 9.1, classNote: 5.6 });
    expect(row.averageTotal).toBe(58.4);
  });

  it("says how many marks are PUBLISHED beside how many exist", async () => {
    // Staff analytics counts drafts on purpose — a teacher wants this BEFORE
    // results go out — so the reader is told how firm the figure is.
    const { service } = makeService();
    const row = (await service.subjectAnalytics(teacher, { termId: "t-1" })).rows[0];
    expect(row).toMatchObject({ entered: 30, published: 12 });
  });

  it("distributes over the school's own grade scale", async () => {
    const { service } = makeService();
    const row = (await service.subjectAnalytics(teacher, { termId: "t-1" })).rows[0];
    expect(row.bands.map((b) => b.grade)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(row.bands.reduce((n, b) => n + b.count, 0)).toBe(30);
  });

  it("aggregates in Postgres — one query, no per-mark hydration", async () => {
    // At a thousand pupils across years of terms, reading every mark into Node
    // to average it grows without bound. GROUP BY on the index that already
    // exists: (schoolId, classId, subjectId, termId).
    const { service, tx } = makeService();
    await service.subjectAnalytics(principal, { termId: "t-1" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlHas(tx, "GROUP BY")).toBe(true);
  });
});

function sqlHas(tx: TenantTx, needle: string): boolean {
  const call = (tx.$queryRaw as unknown as jest.Mock).mock.calls[0][0];
  const sql = (call.sql ?? (call.strings ?? []).join("?")) as string;
  return sql.includes(needle);
}

describe("narrowing", () => {
  it("a single class-subject can be asked for directly", async () => {
    const { service, sqlOf } = makeService();
    await service.subjectAnalytics(principal, { termId: "t-1", classId: "c-9", subjectId: "s-9" });
    const values = (sqlOf()?.values ?? []).map(String);
    expect(values).toContain("c-9");
    expect(values).toContain("s-9");
  });
});
