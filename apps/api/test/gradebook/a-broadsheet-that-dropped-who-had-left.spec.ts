/**
 * A past term's broadsheet dropped every pupil who had since left the class —
 * and moved everybody else's position.
 *
 * Rows were the ACTIVE roster alone, joined against `subject_result` for the
 * term. So a pupil who moved class, withdrew or was promoted out vanished from
 * every PAST broadsheet while their marks sat in the table.
 *
 * Measured live: a pupil with NINE subject results for Term 1 took the sheet
 * from 30 rows to 29 the moment their enrolment stopped being ACTIVE.
 *
 * The rank is the sharper half. `position` is a competition rank computed over
 * these rows, so dropping a pupil who placed third silently promotes everyone
 * below them — and a class position is printed on a report card.
 */
import { TermResultService } from "../../src/gradebook/term-result.service";

const CLASS = "cls-1";
const TERM = "term-1";

/** Three pupils with marks; only two still ACTIVE in the class. */
function makeService() {
  // stu-c is ACTIVE with NO marks — the blank row the CURRENT term needs, and
  // what makes the roster half of the union load-bearing. Without such a pupil
  // a results-only version passes every assertion.
  const enrollments = [{ studentId: "stu-a" }, { studentId: "stu-b" }, { studentId: "stu-c" }];
  const results = [
    { studentId: "stu-a", subjectId: "sub-1", classId: CLASS, termId: TERM, exam: 40, midterm: 15, assignment: 8, classNote: 8 },
    { studentId: "stu-b", subjectId: "sub-1", classId: CLASS, termId: TERM, exam: 20, midterm: 10, assignment: 5, classNote: 5 },
    { studentId: "stu-gone", subjectId: "sub-1", classId: CLASS, termId: TERM, exam: 55, midterm: 18, assignment: 9, classNote: 9 },
  ];
  const tx = {
    class: { findFirst: jest.fn().mockResolvedValue({ id: CLASS, name: "JSS1 A" }) },
    term: { findFirst: jest.fn().mockResolvedValue({ id: TERM, name: "Term 1", sessionId: "ses-1" }) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([{ subjectId: "sub-1" }]) },
    subject: { findMany: jest.fn().mockResolvedValue([{ id: "sub-1", name: "Maths" }]) },
    enrollment: { findMany: jest.fn().mockResolvedValue(enrollments) },
    subjectResult: { findMany: jest.fn().mockResolvedValue(results) },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: "stu-a", name: "Ada" }, { id: "stu-b", name: "Bola" },
        { id: "stu-gone", name: "Chidi" }, { id: "stu-c", name: "Dayo" },
      ]),
    },
    studentProfile: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const svc = Object.create(TermResultService.prototype) as TermResultService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
    canViewClass: jest.fn().mockResolvedValue(true),
    region: { academicInTx: jest.fn().mockResolvedValue({ grading: undefined }) },
  });
  return svc;
}

const P = { schoolId: "sch-1", userId: "staff-1" } as never;
const sheet = (svc: TermResultService) =>
  (svc as unknown as {
    getClassBroadsheet: (p: unknown, a: unknown) => Promise<{ rows: Array<{ studentName: string; position: number | null }> }>;
  }).getClassBroadsheet(P, { classId: CLASS, termId: TERM });

describe("a broadsheet that dropped who had left", () => {
  it("includes a pupil who has results for the term but has since left", async () => {
    const res = await sheet(makeService());
    expect(res.rows.map((r) => r.studentName).sort()).toEqual(["Ada", "Bola", "Chidi", "Dayo"]);
  });

  it("ranks the departed pupil in their real position", async () => {
    // Chidi scored highest. Omitting them made Ada first — a class position
    // printed on a report card.
    const res = await sheet(makeService());
    const byName = new Map(res.rows.map((r) => [r.studentName, r.position]));
    expect(byName.get("Chidi")).toBe(1);
    expect(byName.get("Ada")).toBe(2);
    expect(byName.get("Bola")).toBe(3);
  });

  it("still shows an ACTIVE pupil who has no marks yet", async () => {
    // The other half of the union, and why the ACTIVE roster stays: in the
    // CURRENT term a pupil not yet marked must appear as a blank row. Dayo has
    // no results at all, so a results-only version would drop them.
    const res = await sheet(makeService());
    expect(res.rows.map((r) => r.studentName)).toContain("Dayo");
  });
});
