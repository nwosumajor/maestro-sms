// =============================================================================
// A chain whose last step waits on somebody nobody asked
// =============================================================================
// A performance appraisal runs DRAFT → SUBMITTED by the reviewer → ACKNOWLEDGED
// by the APPRAISEE. The final step is an action only that person can take, and
// the whole service contained no notification code at all — so the appraisal
// simply appeared on a page the staff member had no reason to open that week.
//
// A chain that ends on somebody who was never asked does not complete. It
// stalls, and the stall reads as the staff member ignoring their appraisal.
//
// Found by sweeping for mutations that name ANOTHER person and notify nobody.
// That sweep is noisy — it returned 254 methods before narrowing, and its first
// two "findings" were false alarms: the meeting-request service notifies through
// a helper called `tell`, which no grep for `enqueue` will see. Narrowed to the
// fields that unambiguously mean "this is for someone else", six remained, and
// this is the one where the missing notice breaks the workflow rather than
// merely being polite.
//
// The notice carries NO rating and no comments — an appraisal score is not
// something to put in an inbox line. It says one is ready and where to read it;
// the record stays behind its usual scoping.
// =============================================================================

import { HrReviewsService } from "../../src/hr/reviews.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const reviewer: Principal = {
  schoolId: "S",
  userId: "hr-1",
  roles: ["hr_manager"],
  permissions: ["hr.appraisal.manage"],
};

function makeService(status = "DRAFT") {
  const appraisal = { id: "ap-1", userId: "staff-7", status, rating: 4, reviewerId: "hr-1" };
  const tx = {
    appraisal: {
      findFirst: jest.fn(async () => appraisal),
      update: jest.fn(async (a: { data: { status: string } }) => ({ ...appraisal, status: a.data.status })),
    },
    user: { findFirst: jest.fn(async () => ({ name: "A Teacher" })) },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn() };
  const service = new HrReviewsService(db as never, { record: jest.fn() } as never, notifications as never);
  return { service, notifications, tx };
}

describe("submitting an appraisal", () => {
  it("tells the APPRAISEE, not the reviewer", async () => {
    const { service, notifications } = makeService();
    await service.submitAppraisal(reviewer, "ap-1");
    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][1]).toMatchObject({ recipientId: "staff-7" });
  });

  it("says where to go", async () => {
    // A notice that does not say what to do with it is a smaller version of the
    // same problem.
    const { service, notifications } = makeService();
    await service.submitAppraisal(reviewer, "ap-1");
    const msg = notifications.enqueue.mock.calls[0][1] as { title: string; body: string };
    expect(msg.title).toMatch(/appraisal/i);
    expect(msg.body).toMatch(/acknowledge/i);
  });

  it("carries NO rating and no comments", async () => {
    // The score belongs on the record, behind its scoping — not in an inbox line
    // that a phone shows on a lock screen.
    const { service, notifications } = makeService();
    await service.submitAppraisal(reviewer, "ap-1");
    const sent = JSON.stringify(notifications.enqueue.mock.calls[0][1]);
    expect(sent).not.toMatch(/\brating\b|"4"|:4\b/);
  });

  it("still moves the appraisal to SUBMITTED", async () => {
    const { service, tx } = makeService();
    const dto = await service.submitAppraisal(reviewer, "ap-1");
    expect(tx.appraisal.update).toHaveBeenCalled();
    expect(dto.status).toBe("SUBMITTED");
  });

  it("a failed notification does not undo the submission", async () => {
    // The appraisal is the durable record; the notice is not.
    const { service, notifications } = makeService();
    notifications.enqueue.mockRejectedValueOnce(new Error("queue down"));
    await expect(service.submitAppraisal(reviewer, "ap-1")).resolves.toMatchObject({ status: "SUBMITTED" });
  });

  it("refuses to submit something that is not a DRAFT", async () => {
    // The guard that was already there. Adding a notice must not add a way to
    // re-notify by re-submitting.
    const { service, notifications } = makeService("ACKNOWLEDGED");
    await expect(service.submitAppraisal(reviewer, "ap-1")).rejects.toThrow(/Cannot move from/);
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });
});
