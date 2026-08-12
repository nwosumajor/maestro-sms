// =============================================================================
// A request routed to somebody who then leaves must not be stuck forever
// =============================================================================
// A routed stage names ONE approver, and every exit from PENDING_REVIEW is gated
// to them — approve, reject, and even bouncing it back for revision. There is no
// cancel, no withdraw and no reassign in WORKFLOW_TRANSITIONS.
//
// So when that person left the school, the request was stuck permanently, and
// silently. Confirmed live before the fix, on a real request whose routed
// approver had just exited — all six escape routes closed:
//
//   principal    APPROVE          -> 403 This stage is routed to Demo Head Teacher
//   principal    REJECT           -> 403 This stage is routed to Demo Head Teacher
//   principal    REQUEST_REVISION -> 403 This stage is routed to Demo Head Teacher
//   school_admin (initiator)      -> 403 You cannot review your own request
//
// The initiator saw "pending". Nothing anywhere said the approver was gone.
//
// The fix falls back to the stage's PERMISSION gate once the named approver is
// no longer ACTIVE: the routing is honoured while they are there, and becomes an
// ordinary stage when they are not. A reassign button would have been more
// machinery and would still have needed somebody to NOTICE the deadlock, which
// is exactly what nobody does.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/workflow/workflow.service.ts"), "utf8");

describe("a routed stage whose approver has left", () => {
  it("checks whether the named approver is still ACTIVE before refusing", () => {
    // The refusal must be conditional on the person still being there. Without
    // this lookup the throw is unconditional and the request cannot move.
    const routed = SRC.slice(SRC.indexOf("A ROUTED stage names its approver"));
    expect(routed).toMatch(/status: "ACTIVE"/);
    expect(routed).toMatch(/if \(stillHere\)/);
  });

  it("only throws when they ARE still here", () => {
    // Guards against the fix being inverted — which would refuse everyone
    // except the one person who can no longer sign in.
    const routed = SRC.slice(SRC.indexOf("const stillHere"), SRC.indexOf("routedApproverGone ="));
    expect(routed).toMatch(/if \(stillHere\) \{[\s\S]*?throw new ForbiddenException/);
  });

  it("records on the audit entry that the stage changed hands", () => {
    // A stage acted on by somebody other than its named approver must be
    // visible afterwards, not inferred.
    expect(SRC).toMatch(/routed approver \$\{routedApproverGone\} has left the school/);
  });
});

describe("nobody can be routed to who has already left", () => {
  it("the eligibility check requires an ACTIVE user", () => {
    const chain = SRC.slice(SRC.indexOf("private async buildCustomChain"), SRC.indexOf("listEligibleApprovers"));
    expect(chain).toMatch(/status: "ACTIVE"/);
  });

  it("and the picker never offers one", () => {
    const picker = SRC.slice(SRC.indexOf("async listEligibleApprovers"));
    expect(picker.slice(0, 900)).toMatch(/status: "ACTIVE"/);
  });
});

describe("separation of duties still holds after the fallback", () => {
  it("the initiator is still refused, and the permission gate still applies", () => {
    // The fallback must widen WHO may act, never remove the two rules that make
    // an approval meaningful. Both checks are outside the routed branch, so a
    // departed approver cannot turn a two-person control into a one-person one.
    expect(SRC).toMatch(/mustNotBeInitiator && req\.initiatorId === p\.userId/);
    expect(SRC).toMatch(/!p\.permissions\.includes\(stage\.permission\)/);
    expect(SRC).toMatch(/approvals\.some\(\(a\) => a\.approverId === p\.userId\)/);
  });
});
