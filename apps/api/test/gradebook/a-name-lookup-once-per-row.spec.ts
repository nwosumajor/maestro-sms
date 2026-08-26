// =============================================================================
// A name lookup once per row
// =============================================================================
// `toDto` resolved a selection's term, class, subjects and people itself, and
// `list` called it through `Promise.all(rows.map(...))`. So the cost of a page
// was FOUR QUERIES PER ROW, and a cohort shares its term and its class — 49 of
// every 50 term reads were the same row fetched again.
//
// Measured live on one term of a 901-pupil school, a single 50-row page:
//   term 50 reads · class 50 reads · subject 50 reads · user 55 reads
//   = 205 queries, 211 ms.
//
// This asserts the property through the REAL service, counting the calls a
// multi-row list makes. A test on the mapper alone would prove nothing about
// its caller — the seam that hid the CBT score bug and the report-card
// promotion-line bug before it.
// =============================================================================

import { SubjectSelectionService } from "../../src/gradebook/subject-selection.service";

const ROWS = 40;

function harness() {
  const calls: Record<string, number> = {};
  const count = (k: string) => () => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const rows = Array.from({ length: ROWS }, (_, i) => ({
    id: `sel${i}`,
    schoolId: "s1",
    sessionId: "sess1",
    // ONE term and ONE class across the whole page — the cohort case.
    termId: "t1",
    classId: "c1",
    studentId: `stu${i}`,
    subjectIds: ["sub1", "sub2", "sub3"],
    status: "PENDING_ADMIN",
    supervisorId: null,
    supervisorActedById: null,
    reviewedById: null,
    reviewNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const tx = {
    subjectSelection: {
      findMany: jest.fn(() => Promise.resolve(rows)),
      count: jest.fn(() => Promise.resolve(ROWS)),
    },
    term: {
      findMany: jest.fn((a: { where: { id: { in: string[] } } }) => {
        count("term")();
        return Promise.resolve(a.where.id.in.map((id) => ({ id, name: "First Term" })));
      }),
      findFirst: jest.fn(() => {
        count("term")();
        return Promise.resolve({ id: "t1", name: "First Term" });
      }),
    },
    class: {
      findMany: jest.fn((a: { where: { id: { in: string[] } } }) => {
        count("class")();
        return Promise.resolve(a.where.id.in.map((id) => ({ id, name: "JSS1 A" })));
      }),
      findFirst: jest.fn(() => {
        count("class")();
        return Promise.resolve({ id: "c1", name: "JSS1 A" });
      }),
    },
    subject: {
      findMany: jest.fn((a: { where: { id: { in: string[] } } }) => {
        count("subject")();
        return Promise.resolve(a.where.id.in.map((id) => ({ id, name: id })));
      }),
    },
    user: {
      findMany: jest.fn((a: { where: { id: { in: string[] } } }) => {
        count("user")();
        return Promise.resolve(a.where.id.in.map((id) => ({ id, name: id })));
      }),
    },
  };

  const db = {
    runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
    runAsTenantReadOnly: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
  };
  const svc = new SubjectSelectionService(db as never, { record: jest.fn() } as never);
  return { svc, calls, tx };
}

const admin = {
  userId: "u1",
  schoolId: "s1",
  roles: ["school_admin"],
  permissions: ["grade.read", "subject.selection.approve"],
} as never;

describe("a page of subject selections", () => {
  it("resolves each kind of name ONCE, not once per row", async () => {
    const h = harness();
    const page = await h.svc.list(admin, { filter: "open" });

    expect(page.items).toHaveLength(ROWS);
    // The property. Before this fix each of these was ROWS.
    expect(h.calls).toEqual({ term: 1, class: 1, subject: 1, user: 1 });
  });

  it("still renders every row's names correctly", async () => {
    const h = harness();
    const page = await h.svc.list(admin, { filter: "open" });
    for (const item of page.items) {
      expect(item.termName).toBe("First Term");
      expect(item.className).toBe("JSS1 A");
      expect(item.subjects.map((s) => s.id)).toEqual(["sub1", "sub2", "sub3"]);
      expect(item.studentName).not.toBe("Unknown");
    }
  });

  it("asks for each id once, however many rows share it", async () => {
    // One term and one class across 40 rows, so the batched query must carry
    // ONE id each — a Set, not a list with 40 copies of the same uuid.
    const h = harness();
    await h.svc.list(admin, { filter: "open" });
    expect(h.tx.term.findMany.mock.calls[0][0].where.id.in).toEqual(["t1"]);
    expect(h.tx.class.findMany.mock.calls[0][0].where.id.in).toEqual(["c1"]);
    expect(h.tx.user.findMany.mock.calls[0][0].where.id.in).toHaveLength(ROWS);
  });
});
