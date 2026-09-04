/**
 * The platform asks somebody to decide, and withholds the fact the decision
 * turns on.
 *
 * `STAFF_REQUEST_CHAIN` routes every leave request through head of teaching ->
 * HR manager -> principal. Only the middle one held `hr.leave.manage`, and only
 * the principal held `timetable.read` — so measured against a real school with
 * three staff already off the same week:
 *
 *     head teacher   who else is out 403 · lessons uncovered 403 · register 403
 *     HR manager                     200 ·                   403 ·          200
 *     principal                      403 ·                   200 ·          403
 *
 * and the head teacher could approve regardless. The role map already carries
 * this exact bug for the CONTENT chain ("stage 1 was refused at the door and the
 * chain could never complete"); leave is the same shape, one chain over.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS, STAFF_REQUEST_CHAIN, HR_PERMISSIONS, TIMETABLE_PERMISSIONS } from "@sms/types";

const holdersOf = (perm: string) =>
  Object.keys(ROLE_PERMISSIONS).filter((r) => (ROLE_PERMISSIONS as Record<string, string[]>)[r].includes(perm));

describe("every approver of a leave request can see what they are deciding", () => {
  it("names the chain this test is about, so it cannot silently stop applying", () => {
    expect(STAFF_REQUEST_CHAIN.map((s) => s.key)).toEqual(["HEAD", "HR", "PRINCIPAL"]);
  });

  it("every stage can see WHO ELSE IS OUT on the dates in front of them", () => {
    const src = readFileSync(join(__dirname, "../../src/hr/leave.controller.ts"), "utf8");
    const calendar = src.slice(src.indexOf('@Get("calendar")'));
    const gate = calendar.slice(0, calendar.indexOf(")\n  calendar("));
    for (const stage of STAFF_REQUEST_CHAIN) {
      const roles = holdersOf(stage.permission);
      expect(roles.length).toBeGreaterThan(0); // a stage nobody staffs is its own bug
      // the route admits the stage's own permission, so every approver reaches it
      const constName = stage.permission.split(".").slice(1).join("_").toUpperCase();
      expect(gate).toContain(`REVIEW_${constName.replace("REVIEW_", "")}`);
    }
  });

  it("the head of teaching can see which lessons an absence leaves uncovered", () => {
    // /timetable/cover and /timetable/unstaffed are gated on timetable.read.
    for (const role of holdersOf("workflow.review.head")) {
      expect((ROLE_PERMISSIONS as Record<string, string[]>)[role]).toContain(TIMETABLE_PERMISSIONS.TIMETABLE_READ);
    }
  });

  it("holds for the OTHER staged chains too — a stage-1 approver is never blind", () => {
    // The content chain had this same defect and was fixed by granting
    // lms.content.approve. Assert it stayed fixed, so the pair cannot drift.
    for (const role of holdersOf("workflow.review.head")) {
      expect((ROLE_PERMISSIONS as Record<string, string[]>)[role]).toContain("lms.content.approve");
    }
  });

  // The half that must not be traded away.
  it("does NOT hand an approver HR's administrative register", () => {
    // The register is everybody's leave including what is already finalised;
    // the CALENDAR is who is out on these dates. Only the second is a fact the
    // decision turns on, so only the second was widened.
    const src = readFileSync(join(__dirname, "../../src/hr/leave.controller.ts"), "utf8");
    const register = src.slice(src.indexOf("allRequests("), src.indexOf('@Get("calendar")'));
    const before = src.slice(0, src.indexOf("allRequests("));
    const gate = before.slice(before.lastIndexOf("@RequirePermission("));
    expect(gate).toContain("HR_LEAVE_MANAGE");
    expect(gate).not.toContain("REVIEW_HEAD");
    expect(register).toBeTruthy();
  });

  it("does NOT let an approver rewrite the timetable — seeing is not writing", () => {
    for (const role of holdersOf("workflow.review.head")) {
      expect((ROLE_PERMISSIONS as Record<string, string[]>)[role]).not.toContain(TIMETABLE_PERMISSIONS.TIMETABLE_WRITE);
    }
  });

  it("leaves hr.leave.manage where it was — this widened a READ, not HR's job", () => {
    expect(holdersOf(HR_PERMISSIONS.HR_LEAVE_MANAGE)).toEqual(["hr_manager"]);
  });
});
