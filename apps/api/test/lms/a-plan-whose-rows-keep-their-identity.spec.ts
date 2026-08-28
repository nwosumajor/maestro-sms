// =============================================================================
// A scheme of work whose rows keep their identity
// =============================================================================
// Found by driving a path that had never executed: `subject_syllabus` had no
// rows, so no scheme of work had ever been written.
//
// `upsert` deleted every item and recreated it, carrying the TAUGHT flag forward
// by matching `(week, topic)`. The intent was right and written down — the
// panel's own note says "an edit is not a reset" — and deriving identity from
// CONTENTS cost two things, both measured live:
//
//   rename a TAUGHT week   before: [{w:1,TAUGHT}]  after fixing a typo in its
//                          topic: [{w:1,PLANNED}] — the taught mark lost
//   edit ANY week          a lesson filed against week 2 had its
//                          `syllabusItemId` set to NULL. The FK is ON DELETE
//                          SET NULL, and `updateContent` accepts no
//                          `syllabusItemId`, so a teacher cannot put it back.
//
// WEEK IS NOT A KEY EITHER: the schema says "duplicates are allowed because a
// topic can span weeks". The only stable identity is the row's id, which the
// read already returned and the panel threw away.
//
// Live after: renaming two weeks keeps TAUGHT, every id is stable, and the
// lesson is still linked to week 2.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SVC = readFileSync(join(__dirname, "../../src/lms/syllabus.service.ts"), "utf8");
const CTRL = readFileSync(join(__dirname, "../../src/lms/lms.controller.ts"), "utf8");
const PANEL = readFileSync(join(__dirname, "../../../web/components/lms/SyllabusPanel.tsx"), "utf8");

describe("editing a scheme of work", () => {
  it("does not delete every row and recreate it", () => {
    // The shipped shape. A blanket deleteMany over the plan is what destroyed
    // both the taught marks and the content links.
    const stripped = SVC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/subjectSyllabusItem\.deleteMany\(\{\s*where:\s*\{\s*syllabusId\s*\}/);
  });

  it("deletes only the rows the teacher actually removed", () => {
    expect(SVC).toMatch(/const dropped = prior\.map\(\(r\) => r\.id\)\.filter\(\(id\) => !keepIds\.has\(id\)\)/);
    expect(SVC).toMatch(/deleteMany\(\{ where: \{ id: \{ in: dropped \} \} \}\)/);
  });

  it("updates an existing row in place, so its id survives", () => {
    expect(SVC).toMatch(/subjectSyllabusItem\.update\(/);
  });

  it("never rewrites the taught mark from an edit of the text", () => {
    // `status`/`taughtAt` belong to the one-click "mark taught" action. An edit
    // of the wording must not move them in EITHER direction — carrying them
    // forward by contents is what lost them on a rename.
    const update = SVC.slice(SVC.indexOf("subjectSyllabusItem.update("), SVC.indexOf("if (fresh.length > 0)"));
    expect(update).not.toMatch(/status:/);
    expect(update).not.toMatch(/taughtAt:/);
  });

  it("refuses a row id belonging to another plan", () => {
    // Otherwise one offering's edit could adopt or delete another's row — the
    // check `validateSyllabusTopic` already makes one file over.
    expect(SVC).toMatch(/belongs to a different plan/);
  });

  it("the boundary accepts the id, and the panel sends it back", () => {
    // A server that can use an id and a client that never sends one changes
    // nothing at all.
    expect(CTRL).toMatch(/id: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(PANEL).toMatch(/id: i\.id,/);
    expect(PANEL).toMatch(/\.\.\.\(r\.id \? \{ id: r\.id \} : \{\}\)/);
    // A NEW row must not invent one.
    expect(PANEL).toMatch(/setRows\(\[\.\.\.rows, \{ week:/);
  });
});
