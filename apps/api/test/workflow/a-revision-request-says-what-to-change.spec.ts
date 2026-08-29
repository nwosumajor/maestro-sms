/**
 * A revision request is an INSTRUCTION, so it has to say something.
 *
 * `POST :id/review`, `:id/submit` and `:id/veto` have always accepted
 * `comments`; the engine has always written them into the immutable
 * WorkflowAuditLog; and `WorkflowChain` has always rendered them on the request.
 * Every button in `WorkflowInbox` posted an empty body — so the one field that
 * makes "sent back for changes" actionable was reachable by nothing. Same shape
 * as the meetings page ignoring its own `?open=1` filter, and provisioning never
 * sending `country`.
 *
 * REQUIRED on a revision and nowhere else: an approval speaks for itself and a
 * rejection ends the matter, but sending something BACK asks the initiator to
 * change something and only the reviewer knows what. The same rule, and very
 * nearly the same sentence, as declining a parent's meeting request — "Say why,
 * so the parent knows what to do next."
 */
import { BadRequestException } from "@nestjs/common";
import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const P: Principal = {
  schoolId: "A", userId: "head-1", roles: ["head_teacher"],
  permissions: ["workflow.review", "workflow.review.head"],
};

function make() {
  const transition = jest.fn().mockResolvedValue({ id: "wf-1", state: "REVISION_REQUESTED", currentStage: 0 });
  const s = Object.create(WorkflowService.prototype) as WorkflowService;
  Object.assign(s, { transition });
  return { svc: s, transition };
}

const review = (svc: WorkflowService, action: string, comments?: string) =>
  (svc as unknown as { review: (p: Principal, id: string, a: string, c?: string) => Promise<unknown> })
    .review(P, "wf-1", action, comments);

describe("a revision request says what to change", () => {
  it("refuses one with no instruction", async () => {
    const { svc, transition } = make();
    await expect(review(svc, "REQUEST_REVISION")).rejects.toBeInstanceOf(BadRequestException);
    expect(transition).not.toHaveBeenCalled();
  });

  it("refuses whitespace, which is the same as nothing", async () => {
    const { svc, transition } = make();
    await expect(review(svc, "REQUEST_REVISION", "   \n ")).rejects.toBeInstanceOf(BadRequestException);
    expect(transition).not.toHaveBeenCalled();
  });

  it("says what to do rather than that something was invalid", async () => {
    const { svc } = make();
    await expect(review(svc, "REQUEST_REVISION")).rejects.toThrow(/say what needs to change/i);
  });

  it("passes the instruction through to the transition, which records it", async () => {
    const { svc, transition } = make();
    await review(svc, "REQUEST_REVISION", "please add the dates");
    expect(transition).toHaveBeenCalledWith(
      P, "wf-1", "REQUEST_REVISION", "please add the dates", { mustNotBeInitiator: true },
    );
  });

  it("leaves APPROVE and REJECT free of a required comment", async () => {
    // An approval speaks for itself; a rejection ends the matter. Demanding a
    // note on every decision is how people learn to type "ok" into a box.
    const { svc, transition } = make();
    await review(svc, "APPROVE");
    await review(svc, "REJECT");
    expect(transition).toHaveBeenCalledTimes(2);
  });
});
