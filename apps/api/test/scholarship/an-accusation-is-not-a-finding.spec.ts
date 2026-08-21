// =============================================================================
// A dismissed complaint counted against a child asking for a scholarship
// =============================================================================
// The signals block a reviewer sees carried `disciplineComplaints`: a single
// `count()` over every complaint ever filed against the pupil, at ANY status.
// It sat on the award screen beside their grade average and attendance —
//
//     avg 78%  ·  attendance 94%  ·  discipline: 3
//
// — and nothing on the page said which of OPEN / IN_REVIEW / RESOLVED /
// DISMISSED those three were.
//
// Two things make that worse than imprecise:
//
//   * `discipline.file` is held by STUDENTS. A pupil can file against another
//     pupil, so a classmate's accusation raised the number a reviewer used to
//     decide whether that child got help with their fees.
//   * DISMISSED counted. The school investigated, found it baseless, and the
//     complaint went on counting against the child anyway — permanently, since
//     the signals block is snapshotted at submission.
//
// Golden Rule #8: signals for human review, never a verdict or a penalty. A
// number that cannot tell an accusation from a finding is a penalty wearing a
// signal's clothes.
//
// So: UPHELD and OPEN are counted apart, and DISMISSED is not reported at all —
// the school has already decided it was baseless, and a reviewer cannot unsee a
// number once it is on the page.
// =============================================================================

import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(byStatus: Record<string, number>) {
  const count = jest.fn(({ where }: { where: { status?: string | { in: string[] } } }) => {
    const st = where.status;
    if (typeof st === "string") return Promise.resolve(byStatus[st] ?? 0);
    if (st && "in" in st) return Promise.resolve(st.in.reduce((n, s) => n + (byStatus[s] ?? 0), 0));
    return Promise.resolve(Object.values(byStatus).reduce((a, b) => a + b, 0));
  });
  const tx = {
    subjectResult: { findMany: jest.fn().mockResolvedValue([]) },
    attendanceRecord: { groupBy: jest.fn().mockResolvedValue([]) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    disciplineComplaint: { count },
    taskAssignment: { count: jest.fn().mockResolvedValue(0) },
  } as unknown as TenantTx;
  const svc = Object.create(ScholarshipService.prototype) as ScholarshipService;
  // Built through the prototype, so the injected collaborators have to be
  // supplied. Only the school's grading weights are needed here — the figure
  // under test is the discipline one.
  Object.assign(svc, {
    region: { academicInTx: jest.fn().mockResolvedValue({ grading: { components: [] } }) },
  });
  return {
    collect: () =>
      (svc as unknown as {
        collectSignals(tx: TenantTx, studentId: string, schoolId: string): Promise<Record<string, unknown>>;
      }).collectSignals(tx, "kid-1", "A"),
    count,
  };
}

describe("what the reviewer is told about a pupil's conduct", () => {
  it("counts what was UPHELD, apart from what is undecided", async () => {
    const { collect } = makeService({ RESOLVED: 2, OPEN: 1, IN_REVIEW: 1, DISMISSED: 5 });
    const sig = await collect();
    expect(sig.disciplineUpheld).toBe(2);
    expect(sig.disciplineOpen).toBe(2);
  });

  it("never reports a DISMISSED complaint, in any figure", async () => {
    // The school looked and said no. Five of them must not appear anywhere on
    // the screen that decides whether this child gets help with fees.
    const { collect } = makeService({ DISMISSED: 5 });
    const sig = await collect();
    expect(sig.disciplineUpheld).toBe(0);
    expect(sig.disciplineOpen).toBe(0);
    // Every discipline figure, by name — not a substring search over the whole
    // block. The first version of this line was `not.toContain("5")` on the
    // serialised signals and it went red on the digit inside the capture
    // timestamp (…T09:16:23.856Z): the same guess-a-window shape this suite's
    // sibling was just hardened against, written here an hour later.
    const disciplineFigures = Object.entries(sig)
      .filter(([k]) => k.toLowerCase().includes("discipline"))
      .map(([k, v]) => [k, v] as const);
    expect(disciplineFigures).toEqual([
      ["disciplineUpheld", 0],
      ["disciplineOpen", 0],
    ]);
  });

  it("does not emit the old conflated total", async () => {
    // Leaving it alongside would let the operator screen keep rendering it, and
    // "discipline: 9" beside "1 upheld" is worse than either alone.
    const { collect } = makeService({ RESOLVED: 1, DISMISSED: 8 });
    const sig = await collect();
    expect(sig).not.toHaveProperty("disciplineComplaints");
  });

  it("asks the database for the statuses, rather than counting everything", async () => {
    // Filtering in Node would still have read the dismissed rows and invited
    // the next person to total them.
    const { collect, count } = makeService({ RESOLVED: 1 });
    await collect();
    const wheres = count.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toEqual([
      { againstId: "kid-1", status: "RESOLVED" },
      { againstId: "kid-1", status: { in: ["OPEN", "IN_REVIEW"] } },
    ]);
  });

  it("says zero for a pupil with nothing against them", async () => {
    // Absent is not the same as zero on a screen like this: a missing figure
    // reads as "not checked", and a reviewer should see that it was.
    const { collect } = makeService({});
    const sig = await collect();
    expect(sig.disciplineUpheld).toBe(0);
    expect(sig.disciplineOpen).toBe(0);
  });
});
