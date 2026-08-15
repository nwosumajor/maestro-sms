// =============================================================================
// "Scores recorded to the gradesheet." — even when none were
// =============================================================================
// One press moves a CBT exam's marks onto every candidate's gradesheet. Each
// candidate is applied individually, and a failure on one must not fail the
// batch — so the loop caught everything and counted it as `skipped`:
//
//     } catch {
//       // A candidate who has left the class ... is skipped
//       skipped += 1;
//     }
//
// and the screen then announced a fixed string on any 2xx, without reading the
// response at all:
//
//     act(() => post(`cbt/exams/${e.id}/record-grades`),
//         "Scores recorded to the gradesheet.", false)
//
// So a press that recorded NOTHING was indistinguishable from one that recorded
// the whole class. The reasons are not interchangeable:
//
//   * a candidate who left the class is routine;
//   * PENDING_APPROVAL is not — `applyExamComponent` refuses while a publish
//     request is under head-teacher/principal review, which can account for an
//     ENTIRE class at once, and is something the teacher can resolve.
//
// Believing the marks were filed, nobody would look again until the exam column
// came out empty on the report cards — after results went home.
//
// This is the silent-success class this campaign keeps finding: the outcome is
// reported, the outcome did not happen.
// =============================================================================

import { ConflictException, NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8");
const PANEL = readFileSync(join(__dirname, "../../../web/components/cbt/CbtStaffPanel.tsx"), "utf8");
const pushLoop = SRC.slice(SRC.indexOf("const { examMax } = plan;"), SRC.indexOf("cbt.exam.grades.record"));

describe("the push classifies why it skipped somebody", () => {
  it("separates a review hold from a candidate who left", () => {
    expect(pushLoop).toMatch(/if \(err instanceof ConflictException\) reasons\.awaitingApproval \+= 1;/);
    expect(pushLoop).toMatch(/else if \(err instanceof NotFoundException\) reasons\.notInClass \+= 1;/);
  });

  it("counts a script with no marks separately from a failure", () => {
    // paperMax <= 0 is not an error — there is simply nothing to scale.
    expect(pushLoop).toMatch(/reasons\.unmarked \+= 1;/);
    expect(pushLoop).toMatch(/else reasons\.failed \+= 1;/);
  });

  it("still refuses to let one candidate fail the batch", () => {
    // The original virtue. Classifying the error must not start re-throwing it.
    expect(pushLoop).toMatch(/} catch \(err\) \{/);
    expect(pushLoop).not.toMatch(/throw err/);
  });

  it("returns the reasons to the caller", () => {
    expect(SRC).toMatch(/return \{ recorded, skipped, examMax, reasons, termId: plan\.termId, termName: plan\.termName \};/);
  });

  it("audits them too", () => {
    // The audit row is what answers "why is this pupil's exam column empty"
    // weeks later, when nobody remembers pressing the button.
    expect(SRC).toMatch(/"cbt\.exam\.grades\.record", examId, \{ recorded, skipped, examMax, reasons \}/);
  });

  it("the exceptions it classifies are the ones applyExamComponent throws", () => {
    // Guard against the classification drifting away from the thing classified:
    // the PENDING_APPROVAL refusal is a Conflict, and every scope refusal is a
    // NotFound.
    const term = readFileSync(join(__dirname, "../../src/gradebook/term-result.service.ts"), "utf8");
    const fn = term.slice(term.indexOf("async applyExamComponent("), term.indexOf("async applyAssignmentComponent("));
    expect(fn).toMatch(/PENDING_APPROVAL[\s\S]{0,200}ConflictException/);
    expect(fn).toMatch(/NotFoundException/);
    expect(new ConflictException("x")).toBeInstanceOf(ConflictException);
    expect(new NotFoundException("x")).toBeInstanceOf(NotFoundException);
  });
});

// The tests above read the source; these RUN it. A whole class is skipped
// because its grades are away at review, and the result has to say so.
describe("driving the push", () => {
  const staff = {
    schoolId: "S",
    userId: "teach-1",
    roles: ["teacher"],
    permissions: ["cbt.manage"],
  };

  // NOTE: applyExamComponent(p, input) — the marks are in the SECOND argument.
  function makeService(applyImpl: (p: unknown, args: { studentId: string; exam: number }) => Promise<unknown>) {
    const sittings = [
      { id: "sit-1", studentId: "stu-1", score: 8, questionIds: ["q1", "q2"] },
      { id: "sit-2", studentId: "stu-2", score: 6, questionIds: ["q1", "q2"] },
      { id: "sit-3", studentId: "stu-3", score: 9, questionIds: ["q1", "q2"] },
    ];
    const tx = {
      cbtExam: {
        findFirst: jest.fn(async () => ({
          id: "exam-1",
          bankId: "bank-1",
          classId: "class-1",
          termId: "term-1",
          durationMinutes: 60,
          endAt: new Date("2026-01-01T00:00:00.000Z"),
        })),
      },
      cbtQuestionBank: { findFirst: jest.fn(async () => ({ id: "bank-1", subjectId: "subj-1", createdById: "teach-1" })) },
      classSubjectTeacher: { findFirst: jest.fn(async () => ({ id: "cst-1" })), findMany: jest.fn(async () => []) },
      cbtSitting: { findMany: jest.fn(async () => sittings), updateMany: jest.fn(async () => ({ count: 0 })) },
      cbtTheoryAnswer: { findMany: jest.fn(async () => []) },
      cbtQuestion: { findMany: jest.fn(async () => [{ id: "q1", type: "OBJECTIVE", maxMarks: 1 }, { id: "q2", type: "OBJECTIVE", maxMarks: 1 }]) },
      term: { findFirst: jest.fn(async () => ({ id: "term-1", name: "First Term", sessionId: "sess-1" })) },
      auditLog: { create: jest.fn(async () => ({})) },
    } as unknown as Record<string, unknown>;
    const db = {
      runAsTenant: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    };
    const termResults = { applyExamComponent: jest.fn(applyImpl) };
    const { CbtService } = require("../../src/cbt/cbt.service") as typeof import("../../src/cbt/cbt.service");
    const service = new (CbtService as never as new (...a: unknown[]) => {
      recordExamGrades: (p: unknown, id: string) => Promise<{
        recorded: number;
        skipped: number;
        reasons: { awaitingApproval: number; notInClass: number; unmarked: number; failed: number };
      }>;
    })(
      db,
      { record: jest.fn() },
      { createRequest: jest.fn() },
      termResults,
      { enqueue: jest.fn(), enqueueMany: jest.fn() },
      { academicInTx: async () => ({ grading: { components: [{ key: "exam", max: 60 }] } }) },
      { onFinalized: jest.fn() },
    );
    return { service, termResults };
  }

  it("records everybody when nothing is in the way", async () => {
    const { service } = makeService(async () => ({}));
    const out = await service.recordExamGrades(staff, "exam-1");
    expect(out).toMatchObject({ recorded: 3, skipped: 0 });
    expect(out.reasons).toEqual({ awaitingApproval: 0, notInClass: 0, unmarked: 0, failed: 0 });
  });

  it("names a REVIEW HOLD rather than reporting a bare skip", async () => {
    // The case that read as success: the class's grades are under
    // head-teacher/principal review, so every candidate is refused.
    const { service } = makeService(async () => {
      throw new ConflictException("These grades are awaiting head-teacher/principal approval");
    });
    const out = await service.recordExamGrades(staff, "exam-1");
    expect(out).toMatchObject({ recorded: 0, skipped: 3 });
    expect(out.reasons.awaitingApproval).toBe(3);
    expect(out.reasons.notInClass).toBe(0);
  });

  it("separates a candidate who has left the class", async () => {
    const { service } = makeService(async (_p, { studentId }) => {
      if (studentId === "stu-2") throw new NotFoundException("Student is not enrolled in this class");
      return {};
    });
    const out = await service.recordExamGrades(staff, "exam-1");
    expect(out).toMatchObject({ recorded: 2, skipped: 1 });
    expect(out.reasons).toMatchObject({ notInClass: 1, awaitingApproval: 0 });
  });

  it("one bad candidate still does not fail the batch", async () => {
    const { service } = makeService(async (_p, { studentId }) => {
      if (studentId === "stu-1") throw new Error("boom");
      return {};
    });
    const out = await service.recordExamGrades(staff, "exam-1");
    expect(out).toMatchObject({ recorded: 2, skipped: 1 });
    expect(out.reasons.failed).toBe(1);
  });

  it("says WHICH TERM the marks landed in", async () => {
    // A paper with no term of its own uses the school's CURRENT term, so
    // pressing this in Second Term for a First Term paper writes to Second Term.
    // The fallback is right; being silent about it was not — it confused the
    // author of this code during the live check.
    const { service } = makeService(async () => ({}));
    const out = (await service.recordExamGrades(staff, "exam-1")) as unknown as {
      termId: string;
      termName: string;
    };
    expect(out.termId).toBe("term-1");
    expect(out.termName).toBe("First Term");
  });

  it("scales to the school's own exam maximum and never exceeds it", async () => {
    // 8 of 2 marks is above full; the clamp is what keeps a /60 component at 60.
    const { service, termResults } = makeService(async () => ({}));
    await service.recordExamGrades(staff, "exam-1");
    for (const call of termResults.applyExamComponent.mock.calls) {
      expect(call[1].exam).toBeLessThanOrEqual(60);
    }
  });
});

describe("the screen reports the outcome", () => {
  it("no longer announces a fixed success string", () => {
    // Asserted on the CALL, not on the file: the old wording still appears in
    // the comment explaining why it went, and a test that forbade the words
    // would forbid documenting the bug.
    expect(PANEL).not.toMatch(/,\s*"Scores recorded to the gradesheet\."/);
    // `act` shows its okMsg on any 2xx without reading the body, so the push
    // must not go through it.
    expect(PANEL).not.toMatch(/act\([\s\S]{0,200}record-grades/);
  });

  it("says plainly when nothing was recorded", () => {
    // The case that used to read as success.
    expect(PANEL).toMatch(/recorded === 0\s*\?\s*`Nothing was recorded\$\{where\}\./);
  });

  it("names the review hold, which is the actionable one", () => {
    expect(PANEL).toMatch(/awaiting head-teacher\/principal approval/);
  });

  it("names the other reasons too", () => {
    expect(PANEL).toMatch(/no longer in the class or not offering the subject/);
    expect(PANEL).toMatch(/with no marks to record/);
  });

  it("still surfaces a real HTTP failure through the normal path", () => {
    expect(PANEL).toMatch(/if \(!res\.ok\) \{[\s\S]{0,120}readApiError\(res\)/);
  });
});
