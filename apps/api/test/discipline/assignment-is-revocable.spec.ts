// =============================================================================
// A discipline case could be handed to somebody and never taken back
// =============================================================================
// Found by sweeping for the shape behind the guardian-link defect (#245): a
// relationship table with a `create` and no `delete`, `update` or status
// column — something that can be switched on and never off. Twelve models came
// back; most were correct (`enrollment` has a STATUS, so leaving is a status
// change; the ultimate ARENA tables are transient; the guardian CONSENT flag is
// revocable via `granted`). Two had genuinely nothing. This is the one that
// grants access to records about a child.
//
// `disciplineAssignee` is not a label, it is an ACCESS GRANT:
//
//     downloadEvidence(): if (!this.canManage(p)) {
//       const assigned = await tx.disciplineAssignee.findFirst({ ... });
//       if (!assigned) throw new NotFoundException("Evidence not found");
//     }
//
// so being an assignee is precisely what lets a non-manager open the evidence
// files on a discipline case. `POST /complaints/:id/assign` existed; nothing
// undid it. A mis-picked name was permanent.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const manager: Principal = {
  schoolId: "S",
  userId: "u-head",
  roles: ["principal"],
  permissions: ["discipline.manage", "discipline.file"],
};

function makeService(assignments: Array<{ id: string; complaintId: string; assigneeId: string }>) {
  const audits: Array<{ action: string; metadata?: unknown }> = [];
  const notified: Array<{ recipientId: string; title: string }> = [];
  const deleted: string[] = [];
  const tx = {
    disciplineComplaint: {
      findFirst: jest.fn(async () => ({ id: "c-1", schoolId: "S", complainantId: "u-x", againstId: "s-1" })),
    },
    disciplineAssignee: {
      findFirst: jest.fn(async (a: { where: { complaintId: string; assigneeId: string } }) =>
        assignments.find(
          (x) => x.complaintId === a.where.complaintId && x.assigneeId === a.where.assigneeId,
        ) ?? null,
      ),
      findMany: jest.fn(async () => assignments),
      delete: jest.fn(async (a: { where: { id: string } }) => {
        deleted.push(a.where.id);
        return { id: a.where.id };
      }),
    },
    disciplineEvidence: { findMany: jest.fn(async () => []) },
    disciplineEntry: { findMany: jest.fn(async () => []) },
    user: { findFirst: jest.fn(async () => ({ id: "u-a", name: "A Teacher" })), findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new DisciplineService(
    db as never,
    { record: jest.fn(async (e: { action: string; metadata?: unknown }) => void audits.push(e)) } as never,
    { presignDownload: jest.fn() } as never,
    {
      enqueue: jest.fn(async (_c: unknown, n: { recipientId: string; title: string }) => void notified.push(n)),
    } as never,
  );
  // The DTO assembly reads more tables than this test cares about; the subject
  // under test is the removal, so the shape it returns is stubbed out.
  jest.spyOn(svc as unknown as { complaintDto: () => unknown }, "complaintDto").mockResolvedValue({ id: "c-1" } as never);
  return { svc, audits, notified, deleted };
}

const ASSIGNMENT = { id: "da-1", complaintId: "c-1", assigneeId: "u-a" };

describe("taking a discipline case back off somebody", () => {
  it("removes the assignment", async () => {
    const { svc, deleted } = makeService([ASSIGNMENT]);
    await svc.unassign(manager, "c-1", "u-a");
    expect(deleted).toEqual(["da-1"]);
  });

  it("is audited — it changes who can open a child's evidence", async () => {
    const { svc, audits } = makeService([ASSIGNMENT]);
    await svc.unassign(manager, "c-1", "u-a");
    expect(audits.some((a) => a.action === "discipline.unassign")).toBe(true);
  });

  it("tells the person who has lost the case", async () => {
    // Unlike unlinking a guardian, this one DOES notify: they were told when
    // they got it, they may be part-way through working it, and a case that
    // silently disappears from someone's list is how a case gets dropped.
    const { svc, notified } = makeService([ASSIGNMENT]);
    await svc.unassign(manager, "c-1", "u-a");
    expect(notified).toHaveLength(1);
    expect(notified[0].recipientId).toBe("u-a");
    expect(notified[0].title).toMatch(/no longer assigned/i);
  });

  it("says nothing about the case itself in that notification", async () => {
    // These are records about children. The notification is a pointer.
    const { svc, notified } = makeService([ASSIGNMENT]);
    await svc.unassign(manager, "c-1", "u-a");
    expect(JSON.stringify(notified[0])).not.toMatch(/against|allegation|evidence|detail/i);
  });

  it("404s for an assignment that is not there, rather than succeeding quietly", async () => {
    const { svc, deleted } = makeService([]);
    await expect(svc.unassign(manager, "c-1", "u-a")).rejects.toBeInstanceOf(NotFoundException);
    expect(deleted).toEqual([]);
  });

  it("removes only the person named", async () => {
    const other = { id: "da-2", complaintId: "c-1", assigneeId: "u-b" };
    const { svc, deleted } = makeService([ASSIGNMENT, other]);
    await svc.unassign(manager, "c-1", "u-b");
    expect(deleted).toEqual(["da-2"]);
  });
});

describe("who may do it", () => {
  const SRC = readFileSync(join(__dirname, "../../src/discipline/discipline.service.ts"), "utf8");
  const body = SRC.slice(SRC.indexOf("async unassign"), SRC.indexOf("async addEntry"));

  it("needs discipline.manage, like assigning does", () => {
    expect(body).toMatch(/this\.requireManage\(p\)/);
  });

  it("checks the case is visible BEFORE looking for the assignment", () => {
    // Otherwise this is a probe: a 404-vs-something-else on a case you cannot
    // see tells you whether it exists.
    expect(body.indexOf("requireVisible")).toBeLessThan(body.indexOf("disciplineAssignee.findFirst"));
  });
});

describe("the route", () => {
  const CTRL = readFileSync(join(__dirname, "../../src/discipline/discipline.controller.ts"), "utf8");

  it("exists and is gated like the assign it undoes", () => {
    expect(CTRL).toMatch(/@Delete\("complaints\/:id\/assign\/:assigneeId"\)/);
    const at = CTRL.indexOf('@Delete("complaints/:id/assign/:assigneeId")');
    expect(CTRL.slice(at, at + 220)).toMatch(/DISCIPLINE_MANAGE/);
  });
});
