// =============================================================================
// The operator's headcount counts who is HERE, not who ever was
// =============================================================================
// common/student-scope.ts exists because one definition of "student" was
// answering three different questions. It fixed the Prisma call sites. This one
// is RAW SQL and was missed: `user_role JOIN role`, with nothing looking at
// whether the person is still at the school.
//
// So exiting a single pupil made the operator console read 901 while billing
// charged for 900 — demonstrated against the real database before the fix. That
// gap reads as a school being under-billed, which is the worst kind of wrong
// number: one that invites somebody to act on it.
//
// THE TELL WAS A DEAD CONSTANT. `ON_ROLL_STUDENT_ROLE_ROW` is documented as
// "ON ROLL, expressed against user_role for the cross-tenant fleet sweep" and
// had no callers anywhere. A helper written for a job, never used by that job,
// means the job is doing it some other way — and here the other way was wrong.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ON_ROLL_STUDENT, ON_ROLL_STUDENT_ROLE_ROW, EVER_ENROLLED_STUDENT } from "../../src/common/student-scope";

const sql = readFileSync(join(__dirname, "../../src/operator/operator-people.ts"), "utf8");

describe("the cross-tenant headcount query", () => {
  it("only counts people who are still at the school", () => {
    expect(sql).toMatch(/JOIN "user" u ON u\.id = ur\."userId" AND u\.status = 'ACTIVE'/);
  });

  it("applies that to staff and parents too, not only pupils", () => {
    // Three figures on one screen must answer the same question. A departed
    // teacher is not headcount either.
    const join = /JOIN "user" u ON u\.id = ur\."userId" AND u\.status = 'ACTIVE'/;
    const before = sql.slice(0, sql.search(join));
    // The join precedes the GROUP BY, so every FILTER in the SELECT sees it.
    expect(before).toContain("FILTER (WHERE r.name = 'student')");
    expect(before).toContain("FILTER (WHERE r.name = 'parent')");
  });

  it("still groups per school, so one tenant cannot absorb another's count", () => {
    expect(sql).toMatch(/GROUP BY ur\."schoolId"/);
    expect(sql).toMatch(/WHERE ur\."schoolId" = ANY/);
  });
});

describe("the definitions the rest of the codebase uses", () => {
  it("agree with what the SQL now does", () => {
    // The constant and the query express one rule; if they ever disagree, the
    // console and the bill disagree.
    expect(ON_ROLL_STUDENT_ROLE_ROW).toEqual({ role: { name: "student" }, user: { status: "ACTIVE" } });
    expect(ON_ROLL_STUDENT).toMatchObject({ status: "ACTIVE" });
  });

  it("keep EVER ENROLLED deliberately unfiltered, because an archive owes a leaver their records", () => {
    expect(JSON.stringify(EVER_ENROLLED_STUDENT)).not.toContain("ACTIVE");
  });
});
