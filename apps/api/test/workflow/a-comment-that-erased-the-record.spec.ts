// =============================================================================
// The more a reviewer explained themselves, the less the record said
// =============================================================================
// Every stage decision writes one row to the immutable WorkflowAuditLog, and its
// `comments` column was built as:
//
//     comments ?? [stageNote, elevationNote, departedApproverNote].join("; ")
//
// So anything the reviewer typed REPLACED all three. Those three are facts the
// system knows and the reviewer cannot write and has no reason to: which stage
// of which chain was decided, that the decider's authority came from a
// TEMPORARY ELEVATION rather than their role, and that the named approver for
// the stage had left the school. The comment box is for their own reasoning,
// and the UI invites them to use it — so explaining a decision erased how it
// was reached.
//
// It failed in exactly the wrong direction. The approvals JSON on the request
// kept `viaElevation: true`, while THIS row — the one that exists, in the code's
// own words, because "the detail view can be changed; this row cannot" — lost
// it. Verified live before the fix: a school_admin finalised a staff leave chain
// under an elevation grant and the whole immutable trail read:
//
//     PENDING_REVIEW -> APPROVED | acting for the principal
//
// Nothing recorded that the principal had not decided it. And this is the one
// place it could have been recorded: the guard audits an elevated USE only when
// the grant is what admitted the ROUTE, and the review route asks for the
// generic `workflow.review`, which a school_admin already holds. The granular
// stage permission is consumed deeper in, by the engine — here.
// =============================================================================

import { WorkflowService } from "../../src/workflow/workflow.service";
import { STAFF_REQUEST_CHAIN, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function makeService(request: Record<string, unknown> | null) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    workflowRequest: {
      findFirst: jest.fn().mockResolvedValue(request),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    workflowAuditLog: { create: auditCreate, findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "someone", name: "Someone", status: "ACTIVE" }) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const hooks = { runFinalized: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueueMany: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new WorkflowService(db as never, hooks as never, notifications as never),
    auditCreate,
    trail: () => (auditCreate.mock.calls[0]?.[0] as { data: { comments: string | null } })?.data.comments,
  };
}

const staged = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  type: "LEAVE",
  state: "PENDING_REVIEW",
  initiatorId: "staff",
  payload: {},
  stages: STAFF_REQUEST_CHAIN,
  currentStage: 2, // the PRINCIPAL stage
  approvals: [{ stageKey: "HEAD", approverId: "head1", at: "x" }, { stageKey: "HR", approverId: "hr1", at: "y" }],
  ...over,
});

const principalApprover = (over: Partial<Principal> = {}): Principal => ({
  schoolId: "A",
  userId: "boss",
  roles: [],
  permissions: ["workflow.review", WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL],
  ...over,
});

describe("the immutable trail of a stage decision", () => {
  it("records the stage even when the reviewer wrote a comment", async () => {
    const { service, trail } = makeService(staged());
    await service.review(principalApprover(), "w1", "APPROVE", "happy with this");
    expect(trail()).toContain("happy with this");
    expect(trail()).toMatch(/stage PRINCIPAL approved \(final\)/);
  });

  it("records a decision made under an elevation, comment or no comment", async () => {
    // The case that matters most: this row is the ONLY audit anywhere that a
    // chain stage was decided on borrowed authority.
    const elevatedBoss = principalApprover({ elevated: [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL] } as Partial<Principal>);
    const withComment = makeService(staged());
    await withComment.service.review(elevatedBoss, "w1", "APPROVE", "acting for the principal");
    expect(withComment.trail()).toContain("acting for the principal");
    expect(withComment.trail()).toContain("decided under a temporary elevation grant");

    const without = makeService(staged());
    await without.service.review(elevatedBoss, "w1", "APPROVE");
    expect(without.trail()).toContain("decided under a temporary elevation grant");
  });

  it("says nothing about elevation when the authority came from a role", async () => {
    // The note must mean something. A principal deciding their own stage is the
    // ordinary case and marking it would make the real ones unfindable.
    const { service, trail } = makeService(staged());
    await service.review(principalApprover(), "w1", "APPROVE", "fine");
    expect(trail()).not.toContain("elevation");
  });

  it("keeps the reviewer's own words first", async () => {
    // They are what a human reads the row for; the system's notes are context.
    const { service, trail } = makeService(staged());
    await service.review(principalApprover(), "w1", "APPROVE", "approved on the phone");
    expect(trail()?.indexOf("approved on the phone")).toBe(0);
  });

  it("still writes the notes alone when the reviewer said nothing", async () => {
    const { service, trail } = makeService(staged());
    await service.review(principalApprover(), "w1", "APPROVE");
    expect(trail()).toMatch(/^stage PRINCIPAL approved \(final\)/);
  });

  it("records a REJECTION's stage too", async () => {
    const { service, trail } = makeService(staged());
    await service.review(principalApprover(), "w1", "REJECT", "not this term");
    expect(trail()).toContain("not this term");
    expect(trail()).toMatch(/rejected at stage PRINCIPAL/);
  });
});
