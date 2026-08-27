/**
 * A task whose due date has passed looked exactly like one due next week.
 *
 * `TaskBoard` rendered "due 3 Aug" in the same muted grey either way, and
 * nothing else in the product chases a task deadline — no sweep, no badge, no
 * ordering. The same shape as the operator's onboarding queue, where a lead
 * submitted three weeks earlier was indistinguishable from this morning's: the
 * data was on the row the whole time and the defect was in the drawing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOARD = readFileSync(join(__dirname, "../../components/task/TaskBoard.tsx"), "utf8");

describe("a task due date that had passed", () => {
  it("marks an overdue task", () => {
    expect(BOARD).toMatch(/function isOverdue\(dueAt: string, status: string\)/);
    expect(BOARD).toMatch(/overdue &mdash; was due/);
    // The CALL must drive the branch. Asserting only that the wording exists
    // passes against a dead arm — mutation-tested, and it did.
    expect(BOARD).toMatch(/isOverdue\(t\.dueAt, t\.status\) \? \(/);
  });

  it("says it only while the task is still open", () => {
    // "Overdue" on work somebody finished is a false statement about them, and
    // it teaches a reader to ignore the marker on the rows where it is true.
    expect(BOARD).toMatch(/if \(status === "COMPLETED" \|\| status === "CANCELLED"\) return false/);
  });

  it("still shows a future due date plainly", () => {
    // Magnitude: the assertions above would pass against a board that shouted
    // at every task, or one that stopped showing the date at all.
    expect(BOARD).toMatch(/due \{shortDate\(t\.dueAt\)\}/);
    expect(BOARD).toMatch(/text-muted-foreground">due /);
  });
});
