// =============================================================================
// The principal stage was a role name, not a permission
// =============================================================================
// The last stage of the student chain checked `p.roles.includes("principal")`.
// Only the principal role holds workflow.review.principal today, so this changes
// nothing for any existing school — but it is the difference between a chain a
// school can unstick and one it cannot.
//
// Checked by ROLE NAME, a school whose principal account is deactivated — which
// a staff exit does, deliberately — has every pending request stranded here with
// no way forward. There is no override at this stage, and unlike the supervisor
// stage there is no next reviewer to fail open to: skipping the principal would
// send an application to the platform without the school's endorsement, which is
// the control itself. Each of the three live schools has exactly ONE active
// principal, so one departure strands the queue.
//
// Checked by PERMISSION, the school grants it to another leader and the queue
// moves. It is also how the workflow engine expresses this very stage —
// STAFF_REQUEST_CHAIN's principal step names the same permission — so two
// implementations of one idea now agree instead of drifting.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { WORKFLOW_PERMISSIONS, STAFF_REQUEST_CHAIN } from "@sms/types";
import { ScholarshipService } from "../../src/scholarship/scholarship.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make() {
  const update = jest.fn().mockResolvedValue({ id: "app-1", studentId: "pupil-1" });
  const tx = {
    scholarshipApplication: { findFirst: jest.fn().mockResolvedValue({
      id: "app-1", studentId: "pupil-1", status: "PENDING_PRINCIPAL", applicantRole: "student",
    }), update },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    // One definition of who teaches a class (common/teaches.ts) reads the
    // class SUPERVISOR and the subject offerings too — every real TenantTx
    // answers all three.
    class: { findMany: jest.fn().mockResolvedValue([]) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    parentChild: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as TenantTx;
  const s = Object.create(ScholarshipService.prototype) as ScholarshipService;
  Object.assign(s, {
    db: { runAsTenant: jest.fn(async (_c: TenantContext, fn: (t: TenantTx) => unknown) => fn(tx)) },
    audit: { record: jest.fn() },
    notifications: {},
  });
  (s as unknown as { log: unknown }).log = jest.fn();
  (s as unknown as { toApplicationDtos: unknown }).toApplicationDtos = jest.fn().mockResolvedValue([{ studentName: "Ada" }]);
  (s as unknown as { notifyGuardians: unknown }).notifyGuardians = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { notifyPrincipals: unknown }).notifyPrincipals = jest.fn().mockResolvedValue(undefined);
  (s as unknown as { notifySupervisors: unknown }).notifySupervisors = jest.fn().mockResolvedValue(undefined);
  return { s, update };
}

const who = (roles: string[], permissions: string[]): Principal => ({
  schoolId: "A", userId: "u-1", roles, permissions,
});

describe("deciding the principal stage", () => {
  it("is allowed by the PERMISSION, whoever holds it", async () => {
    const { s, update } = make();
    await s.decideStage(who(["principal"], [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]), "app-1", { decision: "APPROVE", note: "endorsed" });
    expect(update.mock.calls[0][0].data.status).toBe("SUBMITTED");
  });

  it("lets a school that has lost its principal delegate the stage", async () => {
    // The whole point: the head of admin holds the permission, does not hold the
    // role, and the queue moves. Under a role-name check this was a 404 with no
    // remedy available to the school at all.
    const { s, update } = make();
    await s.decideStage(who(["head_admin"], [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]), "app-1", { decision: "APPROVE", note: "acting head" });
    expect(update.mock.calls[0][0].data.status).toBe("SUBMITTED");
  });

  it("still refuses somebody who merely CALLS themselves principal", async () => {
    // The role without the grant decides nothing — the permission is the check.
    const { s, update } = make();
    await expect(s.decideStage(who(["principal"], []), "app-1", { decision: "APPROVE", note: "x" })).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a teacher or a parent outright — 404, not 403", async () => {
    for (const roles of [["teacher"], ["parent"], ["student"]]) {
      const { s, update } = make();
      await expect(s.decideStage(who(roles, []), "app-1", { decision: "APPROVE", note: "x" })).rejects.toThrow(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    }
  });
});

describe("the queue and the gate", () => {
  // A delegate who can decide but sees an empty list has been given nothing.
  // These two must be keyed on the same thing or the grant is dead on arrival.
  function queueFor(roles: string[], permissions: string[]) {
    const findMany = jest.fn().mockResolvedValue([]);
    const tx = {
      // One definition of who teaches a class (common/teaches.ts) reads the
      // class SUPERVISOR and the subject offerings too — every real TenantTx
      // answers all three.
      class: { findMany: jest.fn().mockResolvedValue([]) },
      classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
      enrollment: { findMany: jest.fn().mockResolvedValue([]) },
      parentChild: { findMany: jest.fn().mockResolvedValue([]) },
      scholarshipApplication: { findMany },
    } as unknown as TenantTx;
    const s = Object.create(ScholarshipService.prototype) as ScholarshipService;
    return (s as unknown as { pendingForMe(t: TenantTx, p: Principal): Promise<unknown> })
      .pendingForMe(tx, who(roles, permissions))
      .then(() => findMany.mock.calls.map((c) => (c[0] as { where: { status: string } }).where.status));
  }

  it("shows the pending stage to whoever holds the permission", async () => {
    await expect(queueFor(["head_admin"], [WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL]))
      .resolves.toContain("PENDING_PRINCIPAL");
  });

  it("shows nothing to a principal in name only", async () => {
    await expect(queueFor(["principal"], [])).resolves.not.toContain("PENDING_PRINCIPAL");
  });
});

describe("the two implementations of this stage", () => {
  it("name the same permission", () => {
    // The workflow engine's staff chain ends at a principal step. If these ever
    // diverge again, one of them is deciding by a different rule than the other.
    const principalStep = STAFF_REQUEST_CHAIN.find((st) => st.key === "PRINCIPAL");
    expect(principalStep?.permission).toBe(WORKFLOW_PERMISSIONS.REVIEW_PRINCIPAL);
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/scholarship/scholarship.service.ts"),
      "utf8",
    ) as string;
    expect(src).toMatch(/p\.permissions\.includes\(WORKFLOW_PERMISSIONS\.REVIEW_PRINCIPAL\)/);
    // Nowhere in this service — the queue drifted from the gate once already.
    expect(src).not.toMatch(/p\.roles\.includes\("principal"\)/);
  });
});
