// =============================================================================
// Collecting exam results read three rows per candidate
// =============================================================================
// `collectExamResults` is one button, pressed by the platform owner, over every
// qualified candidate for a programme — which spans every school on the
// platform. It ran three queries for each of them:
//
//   the school's CBT exam   re-read for EVERY pupil in that school, though one
//                           school has exactly one exam for the programme
//   that pupil's sitting
//   the write
//
// `announceExam`, directly above it, groups candidates by school before doing
// any of this. The same job, written twice, one of them per row.
//
// MEASURED against the running system, 200 candidates with real sittings:
//
//     before   1,566 ms / 1,321 ms      ~600 queries
//     after       248 ms /    66 ms        4 queries
//
// And on a programme with no exam at all, the old code still spent 637 ms on 300
// candidates looking for it — a button that did nothing, slowly.
//
// The writes are one statement rather than one per row. Prisma has no bulk
// update with a value per row, so this is UPDATE ... FROM (VALUES ...), chunked
// because Postgres binds at most 65,535 parameters and each row here binds two.
// =============================================================================

import { ScholarshipAdminService } from "../../src/scholarship/scholarship-admin.service";

type Call = { table: string; op: string; args: unknown };

function make(opts: { candidates: number; withSittings: boolean }) {
  const calls: Call[] = [];
  const track = (table: string, op: string, result: unknown) =>
    jest.fn((args: unknown) => {
      calls.push({ table, op, args });
      return Promise.resolve(result);
    });

  const candidates = Array.from({ length: opts.candidates }, (_, i) => ({
    id: `app-${i}`, schoolId: `school-${i % 3}`, studentId: `pupil-${i}`,
  }));
  const exams = [0, 1, 2].map((n) => ({ id: `exam-${n}`, schoolId: `school-${n}` }));
  const sittings = opts.withSittings
    ? candidates.map((c, i) => ({
        examId: `exam-${i % 3}`, studentId: c.studentId, score: i % 11, total: 10,
      }))
    : [];

  const db = {
    scholarshipProgram: { findFirst: track("program", "findFirst", { id: "prog-1", examMode: "ONLINE_CBT" }) },
    scholarshipApplication: {
      findMany: track("application", "findMany", candidates),
      update: track("application", "update", {}),
    },
    cbtExam: { findMany: track("exam", "findMany", exams), findFirst: track("exam", "findFirst", exams[0]) },
    cbtSitting: { findMany: track("sitting", "findMany", sittings), findFirst: track("sitting", "findFirst", sittings[0]) },
    $executeRaw: jest.fn((..._a: unknown[]) => {
      calls.push({ table: "application", op: "$executeRaw", args: null });
      return Promise.resolve(sittings.filter((s) => s.total > 0).length);
    }),
  };
  const s = Object.create(ScholarshipAdminService.prototype) as ScholarshipAdminService;
  Object.assign(s, {
    // The entitlement cache, dropped when a school prize is granted.
    modules: { invalidate: jest.fn() }, privileged: { client: db }, notifications: {}, audit: { record: jest.fn() }, logger: { warn: jest.fn() } });
  (s as unknown as { client: unknown }).client = () => db;
  (s as unknown as { auditOwn: unknown }).auditOwn = jest.fn().mockResolvedValue(undefined);
  return { s, db, calls, candidates };
}

const P = { schoolId: "PLAT", userId: "owner-1", roles: ["super_admin"], permissions: ["scholarship.admin"] } as never;

describe("collecting results for a whole programme", () => {
  it("costs a fixed number of queries, not one per candidate", async () => {
    const { s, calls } = make({ candidates: 200, withSittings: true });
    await s.collectExamResults(P, "prog-1");
    const reads = calls.filter((c) => c.op === "findMany" || c.op === "findFirst");
    // programme + candidates + exams + sittings. Nothing scales with 200.
    expect(reads.length).toBeLessThanOrEqual(5);
    expect(calls.filter((c) => c.op === "findFirst" && c.table === "exam")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "findFirst" && c.table === "sitting")).toHaveLength(0);
  });

  it("writes every score in one statement, never one update per row", async () => {
    const { s, calls, db } = make({ candidates: 200, withSittings: true });
    await s.collectExamResults(P, "prog-1");
    expect(db.scholarshipApplication.update).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === "$executeRaw")).toHaveLength(1);
  });

  it("asks for each school's exam ONCE, however many pupils it has", async () => {
    // The specific waste: 200 candidates across 3 schools re-read 3 exam rows
    // 200 times.
    const { s, db } = make({ candidates: 200, withSittings: true });
    await s.collectExamResults(P, "prog-1");
    const where = (db.cbtExam.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.schoolId.in).toEqual(["school-0", "school-1", "school-2"]);
  });

  it("does no work at all when the programme has no exam", async () => {
    // The old code still spent a lookup per candidate discovering this.
    const { s, calls } = make({ candidates: 300, withSittings: false });
    (calls as unknown as Call[]).length = 0;
    const { s: s2, db: db2, calls: c2 } = make({ candidates: 300, withSittings: false });
    (db2.cbtExam.findMany as jest.Mock).mockResolvedValue([]);
    await s2.collectExamResults(P, "prog-1");
    expect(c2.filter((c) => c.op === "$executeRaw")).toHaveLength(0);
    expect(c2.filter((c) => c.op === "findMany" && c.table === "sitting")).toHaveLength(0);
    void s;
  });
});

describe("the score itself", () => {
  it("is the sitting's percentage, ROUNDED to two decimals", async () => {
    // 1 of 3 is 33.333…, which is the only shape that can tell rounding from no
    // rounding. My first version used scores out of 10, every one of which
    // divides exactly — so removing Math.round changed nothing and the test
    // passed on the mutation.
    const { s, db } = make({ candidates: 1, withSittings: true });
    (db.cbtSitting.findMany as jest.Mock).mockResolvedValue([
      { examId: "exam-0", studentId: "pupil-0", score: 1, total: 3 },
    ]);
    const rounded: Array<{ pct: number }> = [];
    (s as unknown as { writeScores: unknown }).writeScores = jest.fn((_d: unknown, rows: Array<{ pct: number }>) => {
      rounded.push(...rows);
      return Promise.resolve(rows.length);
    });
    await s.collectExamResults(P, "prog-1");
    expect(rounded[0].pct).toBe(33.33);
  });

  it("covers the whole range without drifting", async () => {
    const { s } = make({ candidates: 11, withSittings: true });
    const written: Array<{ id: string; pct: number }> = [];
    (s as unknown as { writeScores: unknown }).writeScores = jest.fn(
      (_db: unknown, rows: Array<{ id: string; pct: number }>) => {
        written.push(...rows);
        return Promise.resolve(rows.length);
      },
    );
    await s.collectExamResults(P, "prog-1");
    // score i%11 out of 10 -> 0, 10, 20 … 100. Verified against the database
    // too: 200 rows, zero mismatches against round(score/total*100, 2).
    expect(written.map((w) => w.pct)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("skips a sitting with no total rather than dividing by zero", async () => {
    const { s, db } = make({ candidates: 2, withSittings: true });
    (db.cbtSitting.findMany as jest.Mock).mockResolvedValue([
      { examId: "exam-0", studentId: "pupil-0", score: 5, total: 0 },
      { examId: "exam-1", studentId: "pupil-1", score: null, total: 10 },
    ]);
    const written: Array<{ pct: number }> = [];
    (s as unknown as { writeScores: unknown }).writeScores = jest.fn((_d: unknown, rows: Array<{ pct: number }>) => {
      written.push(...rows);
      return Promise.resolve(0);
    });
    await s.collectExamResults(P, "prog-1");
    // Not merely "nothing written" — nothing INFINITE or zero written. Dropping
    // the guard turns 5/0 into Infinity and a null score into a real 0%, and a
    // pupil recorded as scoring zero on an exam they never sat is worse than no
    // record at all.
    expect(written).toEqual([]);
    expect(written.every((w) => Number.isFinite(w.pct))).toBe(true);
  });
});
