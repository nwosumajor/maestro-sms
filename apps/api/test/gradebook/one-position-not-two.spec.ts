// =============================================================================
// The teacher's rank and the family's rank were computed over different pupils
// =============================================================================
// The report card's rank carries an explicit requirement, written where it is
// computed:
//
//     "Ranked over PUBLISHED results ONLY, whatever the viewer may see. A
//      position has to be the same number for the parent, the pupil and the
//      teacher — deriving it from the rows each of them is allowed to read
//      would make a teacher's copy disagree with the family's."
//
// The teacher's SCORESHEET, ranking the same pupil in the same subject in the
// same term, filtered only on `total != null` — every entered mark, DRAFT
// included. Mid-term that is not a rounding difference. With ten of thirty
// subject results published, the family's report card said 5th of 10 and the
// scoresheet said 15th of 30, and the teacher was the one who had to explain
// the gap.
//
// Draft marks are still SHOWN on the scoresheet — a teacher must see what they
// are entering. Only the POSITION waits for publication, which is also the
// honest answer: a rank over a half-entered set moves every time a colleague
// saves a mark.
// =============================================================================

import { resolveGradingPolicy } from "@sms/types";
import { TermResultService } from "../../src/gradebook/term-result.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const teacher: Principal = {
  schoolId: "S",
  userId: "t-1",
  roles: ["school_admin"],
  permissions: ["grade.write", "grade.read"],
};

/** Four pupils; two marks published, two still draft — the ordinary mid-term
 *  state of a subject somebody is part-way through entering. */
const RESULTS = [
  { studentId: "s-1", exam: 55, status: "PUBLISHED" }, // 2nd of the published pair
  { studentId: "s-2", exam: 60, status: "PUBLISHED" }, // 1st
  { studentId: "s-3", exam: 58, status: "DRAFT" }, // would sit between them
  { studentId: "s-4", exam: 59, status: "DRAFT" },
];

function makeService() {
  const tx = {
    enrollment: {
      findMany: jest.fn(async () => RESULTS.map((r) => ({ studentId: r.studentId }))),
    },
    subjectSelection: { findMany: jest.fn(async () => []) },
    user: {
      findMany: jest.fn(async () => RESULTS.map((r) => ({ id: r.studentId, name: r.studentId }))),
    },
    studentProfile: { findMany: jest.fn(async () => []) },
    subject: { findFirst: jest.fn(async () => ({ id: "sub-1", name: "Maths" })) },
    term: { findFirst: jest.fn(async () => ({ id: "term-1", name: "Term 1" })) },
    class: { findFirst: jest.fn(async () => ({ id: "c-1", name: "SS2" })) },
    subjectResult: {
      findMany: jest.fn(async () =>
        RESULTS.map((r) => ({
          id: `r-${r.studentId}`,
          studentId: r.studentId,
          classId: "c-1",
          subjectId: "sub-1",
          termId: "term-1",
          // The real column names — `exam`, not `examScore`. With the wrong
          // ones every component read as 0, the two published pupils TIED at
          // zero, and the test failed for a reason that had nothing to do with
          // what it was testing.
          exam: r.exam,
          midterm: null,
          assignment: null,
          classNote: null,
          status: r.status,
        })),
      ),
    },
    classSubjectTeacher: { findFirst: jest.fn(async () => ({ id: "cst-1" })) },
    classTeacher: { findFirst: jest.fn(async () => null) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const region = {
    // The real shape: a resolved policy, exactly as SchoolRegionService builds
    // it from the school's (here absent) override.
    academicInTx: jest.fn(async () => ({ grading: resolveGradingPolicy(null) })),
    forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos" })),
  };
  const svc = new TermResultService(
    db as never,
    { record: jest.fn() } as never,
    {} as never,
    { onFinalized: jest.fn() } as never,
    region as never,
  );
  return { svc };
}

describe("the position on a teacher's scoresheet", () => {
  it("ranks over PUBLISHED results only", async () => {
    const { svc } = makeService();
    const roster = await svc.getGradingRoster(teacher, {
      classId: "c-1",
      subjectId: "sub-1",
      termId: "term-1",
    });
    const by = new Map(
      (roster.students as Array<{ studentId: string; position: number | null }>).map((r) => [
        r.studentId,
        r.position,
      ]),
    );
    // s-2 (60) is 1st and s-1 (55) is 2nd AMONG THE PUBLISHED. The two drafts
    // scoring 58 and 59 would have pushed s-1 to 4th under the old rule.
    expect(by.get("s-2")).toBe(1);
    expect(by.get("s-1")).toBe(2);
  });

  it("leaves a DRAFT result unranked rather than ranking it", async () => {
    // Not "last" either — the same rule the report card uses for an ungraded
    // pupil, for the same reason.
    const { svc } = makeService();
    const roster = await svc.getGradingRoster(teacher, {
      classId: "c-1",
      subjectId: "sub-1",
      termId: "term-1",
    });
    const by = new Map(
      (roster.students as Array<{ studentId: string; position: number | null }>).map((r) => [
        r.studentId,
        r.position,
      ]),
    );
    expect(by.get("s-3")).toBeNull();
    expect(by.get("s-4")).toBeNull();
  });

  it("still SHOWS the draft marks — only the position waits", async () => {
    // A teacher has to see what they are entering.
    const { svc } = makeService();
    const roster = await svc.getGradingRoster(teacher, {
      classId: "c-1",
      subjectId: "sub-1",
      termId: "term-1",
    });
    const rows = roster.students as Array<{ studentId: string; result: { total: number | null } | null }>;
    expect(rows.find((r) => r.studentId === "s-3")?.result?.total).not.toBeNull();
  });
});

describe("the rule both views now share", () => {
  const SRC = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/gradebook/term-result.service.ts"),
    "utf8",
  ) as string;

  it("the report card still ranks published-only", () => {
    // The peer query moved from "this pupil's current classmates" to "everyone
    // with a result in the class the marks were earned in" — a pupil who changes
    // class mid-session was being ranked against the wrong year group. The
    // published-only rule this file exists for is unchanged, and is what is
    // pinned here rather than the shape of the where-clause around it.
    expect(SRC).toMatch(/where: \{ classId: \{ in: cohortClassIds \}, sessionId, status: "PUBLISHED" \}/);
  });

  it("the scoresheet now does too", () => {
    expect(SRC).toMatch(/r\.result\?\.status === "PUBLISHED"/);
  });
});
