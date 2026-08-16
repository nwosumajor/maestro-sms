// =============================================================================
// Three ways a mark reaches a report card, and they must agree
// =============================================================================
// One `subject_result` row per (session, term, subject, student) holds four
// components, and THREE code paths write it:
//
//   * a CBT paper's exam total          -> the `exam` slice
//   * an LMS / assessment aggregate     -> the `assignment` slice
//   * a teacher typing marks            -> any of the four
//
// Each does a READ-MODIFY-WRITE: it reads the components it is not setting so it
// can merge them back. That is what makes them a set rather than three
// independent features, and it is where they were disagreeing.
//
// 1. LOST UPDATE. Two of them at once lose one of the two marks. Proven at the
//    DB layer with the statements the service actually issues:
//
//      before: exam 46, assignment 8
//      CBT reads assignment=8; LMS reads exam=46
//      LMS commits (46, 10); CBT commits (55, 8)
//      after:  exam 55, assignment 8       <- the LMS mark is gone
//
//    and both presses reported success. Now serialised by a transaction-scoped
//    advisory lock keyed on the row's identity — advisory rather than
//    SELECT ... FOR UPDATE because the row often does not exist yet and two
//    concurrent creates race through the unique index into ON CONFLICT.
//
// 2. ONE PUPIL ENDING A PRESS. The CBT push guarded every candidate and counted
//    what it skipped and why. The LMS push had no guard at all, so the first
//    pupil the grading service refused threw out of the whole loop AFTER writing
//    everyone before them — a partial write reported as a failure, with no way
//    to learn how much of it had landed.
//
// 3. A SILENT WITHDRAWAL. Writing a mark onto an already-PUBLISHED result sends
//    it back to DRAFT for re-approval. Correct — and it takes that subject off
//    every live report card until the head teacher and principal pass it again.
//    Neither push mentioned it.
// =============================================================================

import { ConflictException, NotFoundException } from "@nestjs/common";
import { LmsContentService } from "../../src/lms/lms-content.service";
import { TermResultService } from "../../src/gradebook/term-result.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const SRC = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "../../src/gradebook/term-result.service.ts"),
  "utf8",
) as string;

const p: Principal = { schoolId: "S", userId: "t1", roles: ["teacher"], permissions: ["grade.write"] };

/** The LMS gradebook table the apply reads before writing. */
function gradebook(rows: Array<{ studentId: string; suggestedMark: number | null; participated: boolean }>) {
  return {
    classId: "c1",
    subjectId: "sub1",
    subjectName: "Mathematics",
    termId: "t1",
    termName: "Third Term",
    componentMax: 10,
    rows: rows.map((r) => ({ ...r, studentName: r.studentId })),
  };
}

function makeLms(opts: {
  rows: Array<{ studentId: string; suggestedMark: number | null; participated: boolean }>;
  /** studentId -> what applying that pupil does. */
  behaviour?: Record<string, "ok" | "reverted" | "conflict" | "notfound" | "boom">;
}) {
  const applied: string[] = [];
  const termResults = {
    applyAssignmentComponent: jest.fn(async (_p: Principal, input: { studentId: string }) => {
      const how = opts.behaviour?.[input.studentId] ?? "ok";
      if (how === "conflict") throw new ConflictException("awaiting approval");
      if (how === "notfound") throw new NotFoundException("not in class");
      if (how === "boom") throw new Error("kaboom");
      applied.push(input.studentId);
      return { result: {} as never, revertedFromPublished: how === "reverted" };
    }),
  } as unknown as TermResultService;

  const svc = new LmsContentService(
    null as never, null as never, null as never, null as never, null as never, termResults,
  );
  // reason: lmsGradebook is the table this reads and returns; the write loop
  // between the two calls is what is under test.
  (svc as unknown as { lmsGradebook: unknown }).lmsGradebook = jest.fn(async () => gradebook(opts.rows));
  return { svc, applied, termResults };
}

const CLASS_OF_FOUR = [
  { studentId: "a", suggestedMark: 8, participated: true },
  { studentId: "b", suggestedMark: 7, participated: true },
  { studentId: "c", suggestedMark: 9, participated: true },
  { studentId: "d", suggestedMark: 6, participated: true },
];

describe("one pupil's refusal must not end the press", () => {
  it("carries on past a pupil whose marks are away at approval", async () => {
    const { svc, applied } = makeLms({ rows: CLASS_OF_FOUR, behaviour: { b: "conflict" } });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(applied).toEqual(["a", "c", "d"]);
    expect(out.outcome).toMatchObject({ recorded: 3, skipped: 1 });
    expect(out.outcome?.reasons.awaitingApproval).toBe(1);
  });

  it("carries on past a pupil who has left the class", async () => {
    const { svc, applied } = makeLms({ rows: CLASS_OF_FOUR, behaviour: { a: "notfound" } });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(applied).toEqual(["b", "c", "d"]);
    expect(out.outcome?.reasons.notInClass).toBe(1);
  });

  it("reports a press that recorded NOTHING as a press that recorded nothing", async () => {
    // The failure this replaces returned an error naming one pupil, after
    // writing none — indistinguishable, from the teacher's side, from a press
    // that wrote everybody.
    const { svc, applied } = makeLms({
      rows: CLASS_OF_FOUR,
      behaviour: { a: "conflict", b: "conflict", c: "conflict", d: "conflict" },
    });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(applied).toEqual([]);
    expect(out.outcome).toMatchObject({ recorded: 0, skipped: 4 });
    expect(out.outcome?.reasons.awaitingApproval).toBe(4);
  });

  it("counts an unexpected failure separately from a refusal it understands", async () => {
    const { svc } = makeLms({ rows: CLASS_OF_FOUR, behaviour: { c: "boom" } });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(out.outcome?.reasons.failed).toBe(1);
    expect(out.outcome?.reasons.awaitingApproval).toBe(0);
  });

  it("still refuses a press with nothing at all to apply", async () => {
    const { svc } = makeLms({ rows: [{ studentId: "a", suggestedMark: null, participated: false }] });
    await expect(svc.applyLmsGrades(p, "c1", "sub1", "t1")).rejects.toThrow(/No LMS scores/);
  });
});

describe("withdrawing a published result", () => {
  it("is counted and returned, not left for someone to notice", async () => {
    const { svc } = makeLms({ rows: CLASS_OF_FOUR, behaviour: { a: "reverted", d: "reverted" } });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(out.outcome?.revertedFromPublished).toBe(2);
  });

  it("is zero when nothing was published", async () => {
    const { svc } = makeLms({ rows: CLASS_OF_FOUR });
    const out = await svc.applyLmsGrades(p, "c1", "sub1", "t1");
    expect(out.outcome?.revertedFromPublished).toBe(0);
  });

  it("is reported by BOTH pushes and the web panels that drive them", () => {
    const cbt = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/cbt/cbt.service.ts"),
      "utf8",
    ) as string;
    expect(cbt).toMatch(/revertedFromPublished/);
    for (const panel of ["lms/LmsGradebook.tsx", "cbt/CbtStaffPanel.tsx"]) {
      const ui = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../../../web/components", panel),
        "utf8",
      ) as string;
      expect(ui).toMatch(/revertedFromPublished/);
      expect(ui).toMatch(/off report cards until re-approved/);
    }
  });
});

describe("the row every writer shares", () => {
  it("is locked before it is read, on all three write paths", () => {
    // The lock is worthless taken after the read: the point is that the value
    // this write merges back was read while nobody else could change it.
    const calls = [...SRC.matchAll(/await this\.lockResultRow\(/g)];
    expect(calls).toHaveLength(3);
    for (const path of ["applyExamComponent", "applyAssignmentComponent", "upsertResult"]) {
      const from = SRC.indexOf(`async ${path}(`);
      expect([path, from > -1]).toEqual([path, true]);
      const body = SRC.slice(from, SRC.indexOf("subjectResult.upsert", from));
      const lockAt = body.indexOf("lockResultRow");
      const readAt = body.indexOf("subjectResult.findFirst");
      expect([path, lockAt > -1]).toEqual([path, true]);
      if (readAt > -1) expect([path, lockAt < readAt]).toEqual([path, true]);
    }
  });

  it("locks on the row's IDENTITY, so a first write is covered too", () => {
    // The row usually does not exist on the first press of a term, and two
    // concurrent creates race through the unique index into ON CONFLICT DO
    // UPDATE — where the loser writes its own all-null view of the other
    // components. There is nothing to SELECT ... FOR UPDATE until too late.
    expect(SRC).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
    expect(SRC).toMatch(/\$\{key\.sessionId\}:\$\{key\.termId\}:\$\{key\.subjectId\}:\$\{key\.studentId\}/);
  });
});

describe("the warning before the press", () => {
  // Reporting the withdrawal AFTER the fact is honest but late: a teacher who
  // knew would have submitted for approval first. Both cards say it up front,
  // in the same words, because the two buttons do the same thing to a report
  // card and a teacher should not have to learn each one separately.
  const panel = (f: string) =>
    require("node:fs").readFileSync(require("node:path").join(__dirname, "../../../web/components", f), "utf8") as string;

  it.each([["lms/LmsGradebook.tsx"], ["cbt/CbtStaffPanel.tsx"]])("is on %s", (f) => {
    const ui = panel(f).replace(/\s+/g, " ");
    expect(ui).toMatch(/already published sends that subject back to draft/);
    expect(ui).toMatch(/comes off report cards until the head teacher and principal approve it again/);
  });
});
