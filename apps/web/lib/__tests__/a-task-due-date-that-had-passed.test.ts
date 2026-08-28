// =============================================================================
// A task due date that had passed
// =============================================================================
// The board rendered `due {shortDate(t.dueAt)}` in muted grey whether the date
// was next week or three weeks ago, so an overdue task looked exactly like a
// fresh one. Fixed — and the fix applied its own rule to the wrong status.
//
// "Said only while the task is OPEN" was written because "overdue" on work
// somebody finished is a false statement about them, and it teaches a reader to
// ignore the marker on the rows where it is true. But a task stays OPEN until
// the ASSIGNER closes it, so an assignee who had finished their part kept being
// told their work was overdue.
//
// Driven live on the running stack, the first time `task_assignment` ever held a
// row: assignee marks their part DONE -> task status OPEN, myStatus DONE, and
// the board still read "overdue — was due 1 Aug" to the person who did it.
//
// // THE TEST NOW DRIVES THE RULE. It used to assert the literal source
// `function isOverdue(dueAt: string, status: string)`, which went red on the
// change that STRENGTHENED what it guards — the fixed-text failure mode this
// repo keeps recording. `isOverdue` is exported and exercised instead, and the
// two source assertions that remain are the ones a behavioural test cannot make
// (that the call drives the branch, and that a future date still renders).
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOverdue } from "../../components/task/TaskBoard";

const BOARD = readFileSync(join(__dirname, "../../components/task/TaskBoard.tsx"), "utf8");
const PAST = new Date(Date.now() - 30 * 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();

describe("a task due date that had passed", () => {
  it("marks a task nobody has finished", () => {
    expect(isOverdue(PAST, "OPEN", "ASSIGNED")).toBe(true);
    expect(isOverdue(PAST, "IN_PROGRESS", "IN_PROGRESS")).toBe(true);
  });

  it("says nothing about a future date", () => {
    expect(isOverdue(FUTURE, "OPEN", "ASSIGNED")).toBe(false);
  });

  it("says nothing once the task itself is closed", () => {
    expect(isOverdue(PAST, "COMPLETED", "DONE")).toBe(false);
    expect(isOverdue(PAST, "CANCELLED", "ASSIGNED")).toBe(false);
  });

  it("does not tell an assignee their finished work is overdue", () => {
    // The live defect. The task is still OPEN because the ASSIGNER closes it.
    expect(isOverdue(PAST, "OPEN", "DONE")).toBe(false);
    // SUBMITTED counts as finished: they have handed it over and what remains
    // is somebody else's review.
    expect(isOverdue(PAST, "OPEN", "SUBMITTED")).toBe(false);
  });

  it("still tells the ASSIGNER, who is not an assignee", () => {
    // `myStatus` is null for them, and a task with an outstanding assignee IS
    // overdue from where they sit. The fix must not silence the person whose
    // job it is to chase it.
    expect(isOverdue(PAST, "OPEN", null)).toBe(true);
  });

  it("the call drives the branch, with the viewer's own status", () => {
    // A behavioural test cannot see a dead arm: asserting the wording exists
    // passes against a board that never calls this.
    expect(BOARD).toMatch(/isOverdue\(t\.dueAt, t\.status, t\.myStatus\) \? \(/);
    expect(BOARD).toMatch(/overdue &mdash; was due/);
  });

  it("still shows a future due date plainly", () => {
    // Magnitude: the assertions above would pass against a board that shouted at
    // every task, or one that stopped showing the date at all.
    expect(BOARD).toMatch(/due \{shortDate\(t\.dueAt\)\}/);
    expect(BOARD).toMatch(/text-muted-foreground">due /);
  });
});
