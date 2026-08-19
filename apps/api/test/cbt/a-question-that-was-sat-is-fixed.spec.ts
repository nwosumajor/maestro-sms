// =============================================================================
// Correcting a question, and the line where correction becomes rewriting
// =============================================================================
// A question bank was append-only: you could add a question and never fix one.
// A teacher who typed the wrong answer key, or the same question twice, had no
// way back — the remedy was to abandon the bank. Both are editable now.
//
// The line is drawn where a candidate has SAT the question. Every sitting stores
// the exact paper it was served, so "has anyone answered this" is an exact
// question rather than a guess:
//
//   nobody has sat it   draft material — everything is editable, and it can go
//   somebody has        part of an exam record. Its wording, options and answer
//                       are fixed; changing them rewrites a paper that has
//                       already been answered and marked, and the score on file
//                       was computed from the old one.
//
// Level, topic and mark guide stay editable either way: none of them changes
// what a candidate saw or how their answer was judged — they decide which future
// papers may draw the question, and help the human marking a theory answer.
//
// AN OPEN EXAM WINDOW LOCKS THE BANK TOO. Papers are sampled as each candidate
// starts, so during a live window a question nobody holds yet can be handed out
// a moment after the check that said it was free.
// =============================================================================

import { ConflictException, NotFoundException, BadRequestException } from "@nestjs/common";
import { CbtService } from "../../src/cbt/cbt.service";

const SCHOOL = "sch-1";
const STAFF = { userId: "u-author", schoolId: SCHOOL, roles: ["teacher"], permissions: ["cbt.manage"] } as never;

function makeService(opts: { sittings?: number; openExams?: number; canTouch?: boolean; type?: string; answerIndex?: number } = {}) {
  const update = jest.fn();
  const del = jest.fn();
  const log = jest.fn();
  const tx = {
    cbtQuestion: {
      findFirst: jest.fn().mockResolvedValue({
        id: "q1",
        bankId: "b1",
        type: opts.type ?? "OBJECTIVE",
        choices: ["3", "4", "5"],
        answerIndex: opts.answerIndex ?? 1,
      }),
      update,
      delete: del,
    },
    cbtQuestionBank: { findFirst: jest.fn().mockResolvedValue({ id: "b1", createdById: "u-author", subjectId: "s1" }) },
  };
  const svc = Object.create(CbtService.prototype) as CbtService;
  Object.assign(svc, {
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
  });
  (svc as unknown as { log: unknown }).log = log;
  (svc as unknown as { canTouchBank: unknown }).canTouchBank = jest.fn().mockResolvedValue(opts.canTouch ?? true);
  (svc as unknown as { questionUsage: unknown }).questionUsage = jest
    .fn()
    .mockResolvedValue({ sittings: opts.sittings ?? 0, openExams: opts.openExams ?? 0 });
  return { svc, tx, update, del, log };
}

describe("a question nobody has sat", () => {
  it("can have its answer key corrected", async () => {
    const { svc, update } = makeService();
    const out = await svc.updateQuestion(STAFF, "q1", { answerIndex: 2 });
    expect(update).toHaveBeenCalledWith({ where: { id: "q1" }, data: { answerIndex: 2 } });
    expect(out.updated).toEqual(["answerIndex"]);
  });

  it("can have its wording and options replaced together", async () => {
    const { svc, update } = makeService();
    await svc.updateQuestion(STAFF, "q1", { prompt: "  2 + 3 = ?  ", choices: ["4", "5"], answerIndex: 1 });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.prompt).toBe("2 + 3 = ?"); // trimmed
    expect(data.choices).toEqual(["4", "5"]);
  });

  it("can be deleted", async () => {
    const { svc, del } = makeService();
    await expect(svc.deleteQuestion(STAFF, "q1")).resolves.toEqual({ id: "q1", deleted: true });
    expect(del).toHaveBeenCalledWith({ where: { id: "q1" } });
  });

  it("is validated as it will END UP, not just on what was sent", async () => {
    // answerIndex 2 is valid against the three choices on file and invalid
    // against the two being set in the same request. Checking each field alone
    // accepts a question whose key points past its own options.
    // Stored key is the THIRD choice; the request narrows the list to two.
    // Neither field is invalid alone.
    const { svc } = makeService({ answerIndex: 2 });
    await expect(svc.updateQuestion(STAFF, "q1", { choices: ["4", "5"] })).rejects.toThrow(BadRequestException);
    // And the mirror image: a key past the choices already on file.
    const other = makeService();
    await expect(other.svc.updateQuestion(STAFF, "q1", { answerIndex: 5 })).rejects.toThrow(BadRequestException);
  });

  it("does nothing, and says so, when the request changes nothing", async () => {
    const { svc, update } = makeService();
    await expect(svc.updateQuestion(STAFF, "q1", {})).resolves.toEqual({ id: "q1", updated: [] });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("a question a candidate has sat", () => {
  it("will not have its answer key changed under the marks", async () => {
    const { svc, update } = makeService({ sittings: 31 });
    await expect(svc.updateQuestion(STAFF, "q1", { answerIndex: 2 })).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("will not have its wording, options or marks changed either", async () => {
    for (const change of [{ prompt: "new" }, { choices: ["a", "b"] }, { maxMarks: 5 }]) {
      const { svc, update } = makeService({ sittings: 1, type: "THEORY" });
      await expect(svc.updateQuestion(STAFF, "q1", change)).rejects.toThrow(ConflictException);
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("says how many candidates it would have affected", async () => {
    const { svc } = makeService({ sittings: 31 });
    await expect(svc.updateQuestion(STAFF, "q1", { answerIndex: 2 })).rejects.toThrow(/31 candidates have already sat/);
  });

  it("cannot be deleted — the sittings reference it", async () => {
    const { svc, del } = makeService({ sittings: 4 });
    await expect(svc.deleteQuestion(STAFF, "q1")).rejects.toThrow(ConflictException);
    expect(del).not.toHaveBeenCalled();
  });

  it("STILL takes a new level, topic and mark guide", async () => {
    // The point of the split: none of these changes what a candidate saw or how
    // it was marked, and a teacher refining a mark guide mid-marking is normal.
    const { svc, update } = makeService({ sittings: 31, type: "THEORY" });
    const out = await svc.updateQuestion(STAFF, "q1", { level: 3, topic: " Waves ", markGuide: "award 2 for the diagram" });
    expect(out.updated).toEqual(["level", "markGuide", "topic"]);
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.topic).toBe("Waves");
  });
});

describe("while an exam on the bank is open", () => {
  it("the paper fields are refused, because sampling happens as candidates start", async () => {
    const { svc } = makeService({ sittings: 0, openExams: 1 });
    await expect(svc.updateQuestion(STAFF, "q1", { prompt: "x" })).rejects.toThrow(/open right now/);
  });

  it("deletion is refused for the same reason", async () => {
    const { svc, del } = makeService({ sittings: 0, openExams: 1 });
    await expect(svc.deleteQuestion(STAFF, "q1")).rejects.toThrow(/open right now/);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("a bank outside the teacher's subjects", () => {
  it("answers 404, not 403, on edit and on delete", async () => {
    // Same posture as the rest of the module: refusing with "forbidden" tells
    // them the bank exists.
    for (const call of [
      (s: CbtService) => s.updateQuestion(STAFF, "q1", { prompt: "x" }),
      (s: CbtService) => s.deleteQuestion(STAFF, "q1"),
    ]) {
      const { svc } = makeService({ canTouch: false });
      await expect(call(svc)).rejects.toThrow(NotFoundException);
    }
  });
});

describe("the audit trail", () => {
  it("names the fields that moved and never the new answer", async () => {
    // An audit reader is not always someone who may see a key.
    const { svc, log } = makeService();
    await svc.updateQuestion(STAFF, "q1", { answerIndex: 2, topic: "Waves" });
    const meta = log.mock.calls[0][4] as Record<string, unknown>;
    expect(meta.fields).toEqual(["answerIndex", "topic"]);
    expect(JSON.stringify(meta)).not.toContain('"2"');
    expect(meta).not.toHaveProperty("answerIndex");
  });

  it("records a deletion", async () => {
    const { svc, log } = makeService();
    await svc.deleteQuestion(STAFF, "q1");
    expect(log).toHaveBeenCalledWith(expect.anything(), STAFF, "cbt.question.delete", "b1", { questionId: "q1" });
  });
});
