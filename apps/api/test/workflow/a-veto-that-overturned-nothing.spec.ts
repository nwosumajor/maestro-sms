/**
 * A board veto records a reversal and reverses nothing.
 *
 * `WORKFLOW_TRANSITIONS` allows VETO only from APPROVED, so by the time a veto
 * lands the approval's reactor has already run IN-TX: the role was granted, the
 * charges are on families' invoices, the register was amended, the marks were
 * published. Every reactor then opens `if (state !== "APPROVED") return`, and
 * several are additionally guarded on the PRE-approval state
 * (`status: "PENDING_APPROVAL"`, leave still PENDING) — so the REJECTED fan-out
 * a veto produces is a no-op by construction, in every module.
 *
 * Proven live on the sharpest case there is, a privilege grant:
 *   librarian's roles BEFORE   librarian
 *   school_admin appoints      -> ADMIN_APPOINTMENT raised (maker-checker)
 *   principal approves         -> role granted
 *   board VETOES               -> request state REJECTED
 *   librarian's roles AFTER    junior_admin, librarian
 *
 * Making a veto UNDO things is a decision per module with money in it — reversing
 * an invoice is not the same act as removing a role — and is deliberately not
 * taken here. What is fixed is the SILENCE: the announcement said "Your request
 * was rejected", the same words an ordinary review rejection uses, when the two
 * mean opposite things about whether anything happened.
 */
import { WorkflowService } from "../../src/workflow/workflow.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const STAGES = [{ key: "head", label: "Head teacher", permission: "workflow.review.head" }];
const BOARD: Principal = { schoolId: "A", userId: "board-1", roles: ["board"], permissions: ["workflow.veto"] };

function make(holders: string[] = ["head-1", "head-2"]) {
  const enqueueMany = jest.fn().mockResolvedValue(undefined);
  const userRole = { findMany: jest.fn().mockResolvedValue(holders.map((userId) => ({ userId }))) };
  const s = Object.create(WorkflowService.prototype) as WorkflowService;
  Object.assign(s, {
    db: {
      runAsTenantReadOnly: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) =>
        fn({ userRole } as unknown as TenantTx),
      ),
    },
    notifications: { enqueueMany },
    logger: { warn: jest.fn() },
  });
  const announce = (
    s as unknown as { announce: (p: Principal, o: unknown, a: string) => Promise<void> }
  ).announce.bind(s);
  return { announce, enqueueMany };
}

const approved = {
  id: "wf-1",
  title: "Assign role junior_admin to A Librarian",
  initiatorId: "admin-1",
  stages: STAGES,
  currentStage: 0,
  state: "REJECTED", // what a VETO transitions to
};

describe("a veto that overturned nothing", () => {
  it("says the approval already took effect, rather than 'rejected'", async () => {
    const { announce, enqueueMany } = make();
    await announce(BOARD, approved, "VETO");
    const body = enqueueMany.mock.calls[0][2].body as string;
    expect(body).toMatch(/does not undo/i);
    expect(body).toMatch(/already taken effect/i);
  });

  it("does not call it a rejection, which is what an ordinary REJECT means", async () => {
    // The two are opposite statements about whether anything happened, and they
    // used to be the same sentence.
    const { announce, enqueueMany } = make();
    await announce(BOARD, approved, "VETO");
    expect(enqueueMany.mock.calls[0][2].title).not.toMatch(/was rejected/i);
  });

  it("tells the APPROVERS as well as the initiator", async () => {
    // The initiator often cannot undo it: a school administrator who requested
    // an appointment does not necessarily hold rbac.manage, and a teacher cannot
    // reverse an invoice. Whoever approved it is the one who can act.
    const { announce, enqueueMany } = make(["head-1", "head-2"]);
    await announce(BOARD, approved, "VETO");
    const to = enqueueMany.mock.calls[0][1] as string[];
    expect(to).toEqual(expect.arrayContaining(["admin-1", "head-1", "head-2"]));
  });

  it("does not notify the board member who pressed it", async () => {
    const { announce, enqueueMany } = make(["board-1"]);
    await announce(BOARD, { ...approved, initiatorId: "board-1" }, "VETO");
    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it("leaves an ordinary REJECT saying exactly what it said before", async () => {
    // The fix must not reword the common case: a request rejected at review
    // genuinely never happened, and "Your request was rejected" is correct there.
    const { announce, enqueueMany } = make();
    await announce(BOARD, approved, "REJECT");
    expect(enqueueMany.mock.calls[0][2].title).toBe("Your request was rejected");
    expect(enqueueMany.mock.calls[0][1]).toEqual(["admin-1"]);
  });

  it("still tells the next approvers when a request is merely waiting", async () => {
    const { announce, enqueueMany } = make();
    await announce(BOARD, { ...approved, state: "PENDING_REVIEW" }, "APPROVE");
    expect(enqueueMany.mock.calls[0][2].title).toBe("A request is waiting for your approval");
  });
});
