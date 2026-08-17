// =============================================================================
// A guardian link could be created and never removed
// =============================================================================
// `parent_child` decides who sees a child's fees, grades, attendance, report
// cards and documents, and who receives every notification about them. Two
// pieces of code created rows in it — the manual link and the bulk parent
// import — and NOTHING removed them. No endpoint, no service method, no raw
// SQL. Searched exhaustively before believing it.
//
// Proven against the running system, with a principal and the demo parent:
//
//   parent's children BEFORE: Demo Student
//   POST /guardians                                   201
//   parent's children AFTER:  Demo Student, Volume Pupil 7
//     GET /students/<pupil>/profile                   200
//     GET /invoices?studentId=<pupil>                 200
//     GET /documents?studentId=<pupil>                200
//   DELETE /guardians/<pupil>                         404
//   DELETE /guardians?parentId=…&studentId=…          404
//
// One call attached an unrelated adult to a child's entire record, and the only
// way back was somebody running DELETE against the production database — which
// is exactly what had to be done to clean up after that test.
//
// A picker mis-click, a bad row in an import, a step-parent no longer in the
// child's life, a custody order, a safeguarding direction. The last two are not
// requests that can wait for an engineer.
// =============================================================================

import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LmsService } from "../../src/lms/lms.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const admin: Principal = {
  schoolId: "S",
  userId: "u-admin",
  roles: ["school_admin"],
  permissions: ["guardian.write"],
};

function makeService(links: Array<{ id: string; parentId: string; studentId: string }>) {
  const audits: Array<{ action: string; entityId: string; metadata: unknown }> = [];
  const deleted: string[] = [];
  const tx = {
    parentChild: {
      findFirst: jest.fn(async (a: { where: { parentId: string; studentId: string } }) => {
        return (
          links.find((l) => l.parentId === a.where.parentId && l.studentId === a.where.studentId) ?? null
        );
      }),
      delete: jest.fn(async (a: { where: { id: string } }) => {
        deleted.push(a.where.id);
        return { id: a.where.id };
      }),
    },
    auditLog: {
      create: jest.fn(async (a: { data: { action: string; entityId: string; metadata: unknown } }) => {
        audits.push(a.data);
        return a.data;
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new LmsService(db as never, {
    record: jest.fn(async (e: { action: string; entityId: string; metadata: unknown }) => {
      audits.push(e);
    }),
  } as never);
  return { svc, audits, deleted };
}

const LINK = { id: "pc-1", parentId: "p-1", studentId: "s-1" };

describe("removing a guardian link", () => {
  it("removes it", async () => {
    const { svc, deleted } = makeService([LINK]);
    await expect(svc.unlinkGuardian(admin, "p-1", "s-1")).resolves.toEqual({ removed: true });
    expect(deleted).toEqual(["pc-1"]);
  });

  it("is audited — it changes who can see a minor's records", async () => {
    // Golden Rule #5. The link is audited; the unlink has to be, or the record
    // shows a guardian being added and never shows them leaving.
    const { svc, audits } = makeService([LINK]);
    await svc.unlinkGuardian(admin, "p-1", "s-1");
    const entry = audits.find((a) => a.action === "lms.guardian.unlink");
    expect(entry).toBeDefined();
    expect(entry!.entityId).toBe("s-1");
    expect(entry!.metadata).toEqual({ parentId: "p-1" });
  });

  it("answers 404 for a link that is not there", async () => {
    const { svc, deleted } = makeService([]);
    await expect(svc.unlinkGuardian(admin, "p-1", "s-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(deleted).toEqual([]);
  });

  it("answers 404 — not 403 — for another school's link", async () => {
    // RLS confines the lookup to the caller's school, so a foreign link simply
    // is not found. A 403 would confirm that it exists.
    const { svc } = makeService([]); // RLS-scoped read returns nothing
    await expect(svc.unlinkGuardian(admin, "p-elsewhere", "s-elsewhere")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("removes only the pair asked for", async () => {
    const other = { id: "pc-2", parentId: "p-2", studentId: "s-1" };
    const { svc, deleted } = makeService([LINK, other]);
    await svc.unlinkGuardian(admin, "p-1", "s-1");
    expect(deleted).toEqual(["pc-1"]);
  });

  it("allows removing the LAST guardian", async () => {
    // A sole link created in error has to be removable. The pupil record already
    // says plainly, and loudly, when nobody is linked.
    const { svc, deleted } = makeService([LINK]);
    await svc.unlinkGuardian(admin, "p-1", "s-1");
    expect(deleted).toHaveLength(1);
  });
});

describe("the choices made about it", () => {
  const SRC = readFileSync(join(__dirname, "../../src/lms/lms.service.ts"), "utf8");
  const body = SRC.slice(SRC.indexOf("async unlinkGuardian"), SRC.indexOf("// --- relationship-scoped reads"));

  it("tells nobody it happened", () => {
    // Deliberate: notifying the removed guardian is precisely wrong in the case
    // this exists for, and the audit log already records who did it.
    expect(body).not.toMatch(/notif|notify/i);
  });

  it("takes one person, like linking does", () => {
    // Symmetry, and urgency: a safeguarding removal must not wait for a second
    // approver when the attachment it undoes needed only one.
    expect(body).not.toMatch(/workflow|maker|approv/i);
  });
});

describe("the route", () => {
  const CTRL = readFileSync(join(__dirname, "../../src/lms/lms.controller.ts"), "utf8");

  it("exists, and needs the same permission as creating the link", () => {
    expect(CTRL).toMatch(/@Delete\("guardians\/:parentId\/:studentId"\)/);
    const at = CTRL.indexOf('@Delete("guardians/:parentId/:studentId")');
    expect(CTRL.slice(at, at + 200)).toMatch(/GUARDIAN_WRITE/);
  });

  it("validates both ids rather than passing a hand-typed string to the database", () => {
    const at = CTRL.indexOf('@Delete("guardians/:parentId/:studentId")');
    const block = CTRL.slice(at, at + 400);
    expect(block.match(/z\.string\(\)\.uuid\(\)/g) ?? []).toHaveLength(2);
  });
});
