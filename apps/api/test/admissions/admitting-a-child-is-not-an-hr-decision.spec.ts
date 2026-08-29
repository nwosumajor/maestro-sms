/**
 * The HR manager is not in the admissions chain.
 *
 * `ADMISSION_REVIEW_CHAIN` was ADMIN -> HR -> PRINCIPAL, and its own comment
 * said it "mirrors STAFF_REQUEST_CHAIN" — which is where it came from. That
 * chain is right for a STAFF request (leave, a salary change, a contract),
 * because HR owns employment. Admitting a CHILD is not an employment decision,
 * and the copied stage put an approver in front of every family who had nothing
 * to decide.
 *
 * Removed on the owner's decision. What must NOT change with it:
 *   - two people still sign (maker-checker),
 *   - no user may decide two stages (separation of duties),
 *   - `workflow.review.hr` still gates the STAFF chain's middle stage.
 */
import { ADMISSION_REVIEW_CHAIN, STAFF_REQUEST_CHAIN } from "@sms/types";

describe("admitting a child is not an HR decision", () => {
  it("has no HR stage", () => {
    expect(ADMISSION_REVIEW_CHAIN.map((s) => s.key)).toEqual(["ADMIN", "PRINCIPAL"]);
    expect(ADMISSION_REVIEW_CHAIN.some((s) => s.permission === "workflow.review.hr")).toBe(false);
  });

  it("still takes TWO signatures, so it is still maker-checker", () => {
    // Dropping to one stage would remove the control rather than the wrong
    // approver — the thing this change must not do.
    expect(ADMISSION_REVIEW_CHAIN.length).toBeGreaterThanOrEqual(2);
  });

  it("ends with the principal, who is the final authority on a place", () => {
    expect(ADMISSION_REVIEW_CHAIN[ADMISSION_REVIEW_CHAIN.length - 1].permission).toBe(
      "workflow.review.principal",
    );
  });

  it("every stage names a DIFFERENT permission, so one role cannot hold the whole chain", () => {
    const perms = ADMISSION_REVIEW_CHAIN.map((s) => s.permission);
    expect(new Set(perms).size).toBe(perms.length);
  });

  it("leaves the STAFF chain's HR stage alone — this removes HR from admissions, not from the platform", () => {
    expect(STAFF_REQUEST_CHAIN.some((s) => s.permission === "workflow.review.hr")).toBe(true);
  });
});
