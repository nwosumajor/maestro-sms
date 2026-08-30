/**
 * A VETO THE BOARD CAN ACTUALLY USE.
 *
 * `VETO` was reachable ONLY from APPROVED — which is the one moment it cannot
 * work. A veto only lands after the approval's reactor has already run in-tx:
 * the role granted, the charges on families' invoices, the register amended,
 * the marks published. Every reactor then opens `if (state !== "APPROVED")
 * return`, so the REJECTED fan-out a veto produces is a NO-OP by construction,
 * in every module. Proven live before this: a school_admin appointed a
 * junior_admin, the principal approved it, the board vetoed it — the request
 * read REJECTED and the ROLE was still on the account.
 *
 * The answer is not to make a veto unwind six modules, several of which are
 * genuinely irreversible (reversing an invoice is not the same act as removing
 * a role). It is to let the board STOP the decision before it takes effect,
 * which is what a board veto is in governance. From PENDING_REVIEW the request
 * never reaches APPROVED, no reactor runs, and there is nothing to unwind.
 *
 * The post-approval veto is KEPT — a board must be able to record disapproval
 * of something already done — and the two notices now say different things,
 * because only one of them stopped anything.
 *
 * Driven live: veto at PENDING_REVIEW -> 201 REJECTED and "The board has
 * stopped a request" to the initiator and both stage approvers; approve through
 * the full chain then veto -> 201 REJECTED and "a veto does not undo it".
 */
import { WORKFLOW_ACTION_PERMISSION, WORKFLOW_PERMISSIONS, WORKFLOW_TRANSITIONS, ROLE_PERMISSIONS } from "@sms/types";

describe("when the board may veto", () => {
  it("can stop a request that is still under review", () => {
    expect(WORKFLOW_TRANSITIONS.PENDING_REVIEW.VETO).toBe("REJECTED");
  });

  it("can still record disapproval of one already approved", () => {
    expect(WORKFLOW_TRANSITIONS.APPROVED.VETO).toBe("REJECTED");
  });

  it("cannot veto before anything has been put to it", () => {
    // Nothing has been submitted for a decision, so there is no decision to
    // veto — and allowing it would let a veto pre-empt the initiator's own
    // resubmission of a request that was sent back to them.
    for (const state of ["DRAFT", "REVISION_REQUESTED"] as const) {
      expect("VETO" in (WORKFLOW_TRANSITIONS[state] as Record<string, unknown>)).toBe(false);
    }
  });

  it("cannot re-veto a terminal request", () => {
    expect(WORKFLOW_TRANSITIONS.REJECTED).toEqual({});
  });

  it("is the board's power, and the board's alone among school roles", () => {
    // The permission that gates it is unchanged by this — widening WHO may veto
    // is a different decision from widening WHEN.
    expect(WORKFLOW_ACTION_PERMISSION.VETO).toBe(WORKFLOW_PERMISSIONS.VETO);
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => (perms as readonly string[]).includes(WORKFLOW_PERMISSIONS.VETO))
      .map(([role]) => role);
    expect(holders).toEqual(["board"]);
  });
});

describe("what each veto is called", () => {
  const SRC = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "src", "workflow", "workflow.service.ts"),
    "utf8",
  );

  it("distinguishes the two by the state it was cast FROM", () => {
    // Not by the state it produced — both produce REJECTED, so reading the
    // OUTCOME cannot tell them apart. That is the trap the cancelled-invoice
    // notice in this repo already records: key on the TRANSITION.
    expect(SRC).toContain('out.priorState === "PENDING_REVIEW"');
  });

  it("says nothing has taken effect only when nothing has", () => {
    expect(SRC).toContain("It will not go ahead, and nothing has taken effect.");
    expect(SRC).toContain("a veto does not undo it");
  });

  it("still tells the approvers, not only the initiator", () => {
    // The initiator often cannot undo it: a school_admin who requested an
    // appointment need not hold rbac.manage, and a teacher cannot reverse an
    // invoice. The people who CAN act are the ones who approved it.
    const body = SRC.slice(SRC.indexOf('if (action === "VETO")'), SRC.indexOf('if (out.state === "PENDING_REVIEW")'));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("approversFor");
    expect(body).toContain("out.initiatorId");
    // …and never to the board member who cast it.
    expect(body).toContain("id !== p.userId");
  });
});
