// =============================================================================
// A theory mark that was awarded, recorded, and then not shown
// =============================================================================
// `cbt_sitting.score` holds a script's OBJECTIVE part only — deliberately: it is
// written when the candidate submits, and theory is marked later by a human.
// `provisional` exists to say "not final yet", and `markingProgress` states the
// rule outright: while any theory answer is unmarked, the stored score "is only
// its objective part and must not be presented as final".
//
// The moment marking FINISHED, `provisional` went false and that same
// objective-only number was presented as final — to the candidate on their own
// results screen, and to staff on the exam results table.
//
// Measured live on a 2-question paper (1 objective + one 10-mark theory answer,
// marked 8 out of 10): the candidate had scored 9 of 11 and was shown 1 of 11.
// `recordGrades` computed the sum itself and filed 49.09/60 — 9/11 scaled to the
// school's exam component — so THE RECORD WAS RIGHT while every number a human
// could read disagreed with it. That is the worst shape for this kind of bug:
// nothing downstream is corrupt, so nothing ever surfaces the contradiction.
//
// The results table was the sharper half. It orders by score once marking
// completes, and its own comment explains why it does NOT do so before: "a
// ranking built on half-marked scripts actively inverts — the candidates
// strongest on theory sit at the bottom". Ordering by the objective part after
// marking produces exactly that inversion, having gone to the trouble of
// avoiding it during.
// =============================================================================

import { CbtService, scriptScore } from "../../src/cbt/cbt.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const EXAM = {
  id: "e1", bankId: "b1", classId: "c1", status: "PUBLISHED", answerRelease: "WITHHELD",
  durationMinutes: 30, startAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000),
  title: "Probe paper", questionCount: 2,
};
const SITTING = {
  id: "sg1", examId: "e1", studentId: "s1", status: "SUBMITTED",
  startedAt: new Date(Date.now() - 1800_000), submittedAt: new Date(),
  // The OBJECTIVE part only, exactly as the column is written on submit.
  score: 1, total: 11, questionIds: ["q1", "t1"], answers: { q1: 1 },
};

/** A service whose theory rows carry the marks a human has awarded. */
function viewService(theory: Array<{ sittingId: string; questionId: string; marksAwarded: number | null }>) {
  const tx = {
    cbtSitting: {
      findFirst: jest.fn().mockResolvedValue(SITTING),
      findMany: jest.fn().mockResolvedValue([SITTING]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(1),
    },
    cbtExam: { findFirst: jest.fn().mockResolvedValue(EXAM), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    cbtQuestionBank: { findFirst: jest.fn().mockResolvedValue({ id: "b1", schoolId: "A", subjectId: "sub1", createdById: "t1" }) },
    cbtQuestion: {
      findMany: jest.fn().mockResolvedValue([
        { id: "q1", prompt: "2+2?", choices: ["3", "4"], answerIndex: 1, type: "OBJECTIVE", maxMarks: 1 },
        { id: "t1", prompt: "Explain.", choices: [], answerIndex: null, type: "THEORY", maxMarks: 10 },
      ]),
    },
    cbtTheoryAnswer: { findMany: jest.fn(async () => theory) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: "s1", name: "Ada" }]), findFirst: jest.fn().mockResolvedValue({ id: "s1", name: "Ada" }) },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    class: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  return new CbtService(db as never, { record: jest.fn() } as never, {} as never, {} as never,
    { enqueue: jest.fn() } as never,
    { academicInTx: async () => ({ grading: { components: [{ key: "exam", max: 60 }] } }), inTx: async () => ({ timezone: "UTC" }) } as never,
    { hasIntegrityConsent: async () => true } as never, { onFinalized: () => undefined } as never);
}

const pupil: Principal = { schoolId: "A", userId: "s1", roles: ["student"], permissions: ["cbt.take"] };
const staff: Principal = { schoolId: "A", userId: "t1", roles: ["teacher"], permissions: ["cbt.manage", "cbt.review"] };

describe("what a script scored", () => {
  it("is the objective part plus every theory mark awarded", () => {
    expect(scriptScore(1, 8)).toBe(9);
  });

  it("counts an unmarked theory answer as nothing, not as a missing script", () => {
    // The candidate has 1 objective mark and nothing awarded yet. 1, not null:
    // `provisional` is what says the figure is not final.
    expect(scriptScore(1, 0)).toBe(1);
  });

  it("treats a null objective score as zero", () => {
    // A script with no objective section at all is a theory-only paper, not an
    // absent result.
    expect(scriptScore(null, 7)).toBe(7);
  });

  it("is the figure the filed grade is scaled from", () => {
    // recordGrades scales raw/paperMax onto the school's exam component. The
    // live probe filed 49.09 of 60, which is 9/11 — so any reader disagreeing
    // with scriptScore disagrees with the grade in the child's record.
    const raw = scriptScore(1, 8);
    const paperMax = 11;
    expect(Number(((raw / paperMax) * 60).toFixed(2))).toBe(49.09);
  });

  it("the CANDIDATE'S OWN VIEW shows it — the helper existing is not the same as being called", async () => {
    const svc = viewService([{ sittingId: "sg1", questionId: "t1", marksAwarded: 8 }]);
    const view = await svc.getSitting(pupil, "sg1");
    expect({ score: view.score, total: view.total, provisional: view.provisional }).toEqual({
      score: 9,
      total: 11,
      provisional: false,
    });
  });

  it("stays provisional, and still counts what HAS been awarded, while marking continues", async () => {
    const svc = viewService([
      { sittingId: "sg1", questionId: "t1", marksAwarded: 8 },
      { sittingId: "sg1", questionId: "t2", marksAwarded: null },
    ]);
    const view = await svc.getSitting(pupil, "sg1");
    expect([view.score, view.provisional]).toEqual([9, true]);
  });

  it("the STAFF RESULTS TABLE shows it too, and ranks on it", async () => {
    const svc = viewService([{ sittingId: "sg1", questionId: "t1", marksAwarded: 8 }]);
    const res = await svc.examResults(staff, "e1");
    expect(res.provisional).toBe(false);
    expect(res.rows.map((r) => r.score)).toEqual([9]);
  });
});
