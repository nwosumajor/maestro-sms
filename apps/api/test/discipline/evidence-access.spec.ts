// =============================================================================
// Shown the evidence, refused the evidence
// =============================================================================
// A disciplinary case can carry attachments — a photo, a statement, a letter.
// The case DETAIL lists them (filename and uploader) to anyone who can see the
// case, and an earlier fix put ASSIGNEES into that read scope, because
// `assigneeId` had been written and never read.
//
// Opening one still required `discipline.manage`. So the person made responsible
// for resolving a matter about a child was shown "photo-of-incident.jpg" on the
// case they had been assigned, and then refused it — and had to ask somebody
// else to look at the thing they were supposed to act on. The same shape as the
// fix that preceded it: the read scope was widened at one door and not the next.
//
// The FILER is deliberately still refused. They can see the case they raised,
// and they can see that evidence exists — which is what tells them it is being
// worked — but investigative material may concern people other than the person
// who complained, and being the complainant is not a reason to receive it.
// =============================================================================

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DisciplineService } from "../../src/discipline/discipline.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "school-A";
const who = (userId: string, permissions: string[]): Principal => ({
  schoolId: SCHOOL,
  userId,
  roles: [],
  permissions,
});

const manager = who("head-1", ["discipline.manage", "discipline.file"]);
const assignee = who("tutor-1", ["discipline.file"]);
const filer = who("pupil-1", ["discipline.file"]);

function makeService(opts: { assignedTo?: string | null } = {}) {
  const { assignedTo = "tutor-1" } = opts;
  const presign = jest.fn().mockResolvedValue({ url: "https://storage/evidence.jpg" });
  const tx = {
    // The caller must be able to SEE the case before the evidence question is
    // even asked — that check is what keeps the coarse route gate safe.
    disciplineComplaint: {
      findFirst: jest.fn(async () => ({ id: "c-1", againstId: "pupil-9", againstType: "STUDENT" })),
    },
    disciplineAssignee: {
      findFirst: jest.fn(async (args: { where: { assigneeId: string } }) =>
        assignedTo && args.where.assigneeId === assignedTo ? { id: "a-1" } : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    disciplineEvidence: {
      findFirst: jest.fn().mockResolvedValue({ id: "ev-1", complaintId: "c-1", fileKey: "k-1" }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new DisciplineService(
    db as never,
    { record: jest.fn() } as never,
    { presignDownload: presign, presignUpload: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
  );
  return { service, presign, tx };
}

describe("opening a piece of evidence", () => {
  it("a manager can", async () => {
    const { service, presign } = makeService();
    await expect(service.downloadEvidence(manager, "c-1", "ev-1")).resolves.toMatchObject({
      url: "https://storage/evidence.jpg",
    });
    expect(presign).toHaveBeenCalled();
  });

  it("the ASSIGNEE can — this is the case that was broken", async () => {
    const { service, presign } = makeService({ assignedTo: "tutor-1" });
    await expect(service.downloadEvidence(assignee, "c-1", "ev-1")).resolves.toBeDefined();
    expect(presign).toHaveBeenCalled();
  });

  it("somebody assigned to a DIFFERENT case cannot", async () => {
    // Being an assignee somewhere is not being an assignee here.
    const { service, presign } = makeService({ assignedTo: "someone-else" });
    await expect(service.downloadEvidence(assignee, "c-1", "ev-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(presign).not.toHaveBeenCalled();
  });

  it("the FILER cannot, deliberately", async () => {
    // They see the case and that evidence exists; the material itself may
    // concern third parties.
    const { service, presign } = makeService({ assignedTo: null });
    await expect(service.downloadEvidence(filer, "c-1", "ev-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(presign).not.toHaveBeenCalled();
  });

  it("refuses with 404, never 403", async () => {
    // Whether a piece of evidence exists on a case you cannot see is itself
    // something you should not learn.
    const { service } = makeService({ assignedTo: null });
    await expect(service.downloadEvidence(filer, "c-1", "ev-1")).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it("never mints a URL before deciding", async () => {
    // A presigned link is a bearer token; refusing after handing one out would
    // refuse nothing.
    const { service, presign } = makeService({ assignedTo: null });
    await service.downloadEvidence(filer, "c-1", "ev-1").catch(() => undefined);
    expect(presign).not.toHaveBeenCalled();
  });
});

describe("the route gate, not just the service", () => {
  // Widening the service alone changed NOTHING: the guard refused first, and a
  // suite that constructs the service directly cannot see a decorator. The live
  // check caught it. These assertions are the part that would have.
  const CONTROLLER = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/discipline/discipline.controller.ts"),
    "utf8",
  ) as string;

  const gateFor = (route: string): string => {
    const at = CONTROLLER.indexOf(`@Get("${route}")`);
    return CONTROLLER.slice(at, CONTROLLER.indexOf(")", CONTROLLER.indexOf("@RequirePermission", at)));
  };

  it("opening evidence is gated the same way as the case that lists it", () => {
    // Anything narrower and the guard pre-empts the assignee check below it.
    expect(gateFor("complaints/:id/evidence/:evidenceId")).toContain("DISCIPLINE_FILE");
    expect(gateFor("complaints/:id")).toContain("DISCIPLINE_FILE");
  });

  it("the coarse gate is safe ONLY because the service narrows", () => {
    // If this ever stops being true, the route above is handing evidence to
    // every complaint-filer in the school.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/discipline/discipline.service.ts"),
      "utf8",
    ) as string;
    const fn = src.slice(src.indexOf("async downloadEvidence("));
    expect(fn.slice(0, 700)).toMatch(/if \(!this\.canManage\(p\)\)/);
    expect(fn.slice(0, 700)).toMatch(/disciplineAssignee\.findFirst/);
  });

  it("WRITING evidence stays manage-only", () => {
    // Reading was widened. Uploading and confirming were not.
    for (const route of ["evidence/presign", "evidence/confirm"]) {
      const at = CONTROLLER.indexOf(`@Post("complaints/:id/${route}")`);
      expect(CONTROLLER.slice(at, at + 200)).toContain("DISCIPLINE_MANAGE");
    }
  });
});

describe("the read is still recorded", () => {
  it("every opened piece of evidence is audited", async () => {
    // Golden Rule #5: this is material about a child.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/discipline/discipline.service.ts"),
      "utf8",
    ) as string;
    const fn = src.slice(src.indexOf("async downloadEvidence("), src.indexOf("async downloadEvidence(") + 1400);
    expect(fn).toMatch(/this\.log\(tx, p, "discipline\.evidence\.read", complaintId, \{ evidenceId \}\)/);
  });
});
