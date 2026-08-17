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

// =============================================================================
// …and linking accepted anything at all
// =============================================================================
// Putting the link form on the pupil's record — beside the list of who is
// already attached — meant asking what the endpoint behind it actually accepts.
// It was a bare `create` on two ids taken from the request body. Every one of
// these came back 201 from the running system:
//
//   201  a TEACHER as the guardian
//   201  the pupil as their OWN guardian
//   201  the platform SYSTEM account, which is in another org entirely
//   500  the SAME pair twice        <- unique violation, straight to the client
//
// The duplicate is the one a real user hits, and it hits it more often now that
// the form sits next to the list of existing guardians.
// =============================================================================

import { BadRequestException, ConflictException } from "@nestjs/common";

type Role = { userId: string; role: { name: string } };

function makeLinker(opts: {
  users: Array<{ id: string; name: string }>;
  roles: Role[];
  links?: Array<{ id: string; parentId: string; studentId: string }>;
}) {
  const created: Array<{ parentId: string; studentId: string }> = [];
  const tx = {
    user: {
      findFirst: jest.fn(async (a: { where: { id: string } }) =>
        opts.users.find((u) => u.id === a.where.id) ?? null,
      ),
    },
    userRole: {
      findMany: jest.fn(async (a: { where: { userId: { in: string[] } } }) =>
        opts.roles.filter((r) => a.where.userId.in.includes(r.userId)),
      ),
    },
    parentChild: {
      // The service reads THIS PUPIL's whole guardian list — it needs the count
      // for the cap as well as the duplicate check.
      findMany: jest.fn(async (a: { where: { studentId: string } }) =>
        (opts.links ?? []).filter((l) => l.studentId === a.where.studentId),
      ),
      create: jest.fn(async (a: { data: { parentId: string; studentId: string } }) => {
        created.push(a.data);
        return { id: "new", ...a.data };
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new LmsService(db as never, { record: jest.fn() } as never);
  return { svc, created };
}

const MUM = { id: "p-1", name: "Amaka Obi" };
const PUPIL = { id: "s-1", name: "Chidi Obi" };
const TEACHER = { id: "t-1", name: "Mr Bello" };
const ROLES: Role[] = [
  { userId: "p-1", role: { name: "parent" } },
  { userId: "s-1", role: { name: "student" } },
];

describe("attaching a guardian to a pupil", () => {
  it("works for a parent account and a pupil", async () => {
    const { svc, created } = makeLinker({ users: [MUM, PUPIL], roles: ROLES });
    await svc.linkGuardian(admin, "p-1", "s-1");
    expect(created).toEqual([{ schoolId: "S", parentId: "p-1", studentId: "s-1" }]);
  });

  it("refuses the SAME pair twice with a 409, not a 500", async () => {
    const { svc, created } = makeLinker({
      users: [MUM, PUPIL],
      roles: ROLES,
      links: [{ id: "pc-1", parentId: "p-1", studentId: "s-1" }],
    });
    await expect(svc.linkGuardian(admin, "p-1", "s-1")).rejects.toBeInstanceOf(ConflictException);
    expect(created).toEqual([]);
  });

  it("names both people when it refuses a duplicate", async () => {
    // "Already linked" leaves the office wondering which row it meant.
    const { svc } = makeLinker({
      users: [MUM, PUPIL],
      roles: ROLES,
      links: [{ id: "pc-1", parentId: "p-1", studentId: "s-1" }],
    });
    await expect(svc.linkGuardian(admin, "p-1", "s-1")).rejects.toThrow(/Amaka Obi.*Chidi Obi/);
  });

  it("refuses a pupil as their own guardian", async () => {
    const { svc } = makeLinker({ users: [PUPIL], roles: ROLES });
    await expect(svc.linkGuardian(admin, "s-1", "s-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an account that is not a guardian", async () => {
    // A teacher linked as a guardian gets parent-scoped reach into a child's
    // fees, grades and documents.
    const { svc, created } = makeLinker({ users: [TEACHER, PUPIL], roles: ROLES });
    await expect(svc.linkGuardian(admin, "t-1", "s-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(created).toEqual([]);
  });

  it("says what to do about a staff member who IS also a parent", async () => {
    // A teacher whose child attends the school is ordinary. Roles are additive,
    // so the answer is to give that account the parent role — and the refusal
    // has to say so, or the office is stuck.
    const { svc } = makeLinker({ users: [TEACHER, PUPIL], roles: ROLES });
    await expect(svc.linkGuardian(admin, "t-1", "s-1")).rejects.toThrow(/parent role/i);
  });

  it("refuses a pupil who is not a student", async () => {
    const { svc } = makeLinker({ users: [MUM, TEACHER], roles: ROLES });
    await expect(svc.linkGuardian(admin, "p-1", "t-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("cannot reach a user in another school", async () => {
    // Both ids are re-read through the tenant client, so RLS confines them and
    // anyone else is NOT FOUND — the ids came from a request body.
    const { svc, created } = makeLinker({ users: [MUM], roles: ROLES });
    await expect(svc.linkGuardian(admin, "p-1", "s-elsewhere")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toEqual([]);
  });

  it("checks the ids BEFORE writing anything", async () => {
    const { svc, created } = makeLinker({ users: [], roles: [] });
    await expect(svc.linkGuardian(admin, "p-1", "s-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(created).toEqual([]);
  });
});

// =============================================================================
// How many adults may be attached to one child
// =============================================================================
// Asked whether the cap should be 2. It should not, and the reasoning is in
// `packages/types/src/guardians.ts` — briefly: a boarding pupil normally has
// parents PLUS a local guardian who is the person actually telephoned, which is
// three before anything unusual; separated parents plus a step-parent is three.
//
// The failure mode decides the number. At the cap the office does the only
// thing the software allows — unlink somebody to make room — and the mother
// then stops receiving absence alerts and invoices silently, with nothing on
// screen to say she was removed. A cap worked around by deleting an access
// grant causes the harm it exists to prevent.
//
// So the cap is set to catch the RUNAWAY, which looks like forty (a repeated
// admission number in an import, a column mapped to the wrong field), not five.
// =============================================================================

import { MAX_GUARDIANS_PER_STUDENT } from "@sms/types";

function makeCapped(existing: Array<{ parentId: string }>, names: Record<string, string>) {
  const created: Array<{ parentId: string }> = [];
  const tx = {
    user: {
      findFirst: jest.fn(async (a: { where: { id: string } }) =>
        names[a.where.id] ? { id: a.where.id, name: names[a.where.id] } : null,
      ),
      findMany: jest.fn(async (a: { where: { id: { in: string[] } } }) =>
        a.where.id.in.filter((id) => names[id]).map((id) => ({ id, name: names[id] })),
      ),
    },
    userRole: {
      findMany: jest.fn(async (a: { where: { userId: { in: string[] } } }) =>
        a.where.userId.in.map((userId) => ({
          userId,
          role: { name: userId.startsWith("s-") ? "student" : "parent" },
        })),
      ),
    },
    parentChild: {
      findMany: jest.fn(async () => existing),
      create: jest.fn(async (a: { data: { parentId: string } }) => {
        created.push(a.data);
        return { id: "new", ...a.data };
      }),
    },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  return { svc: new LmsService(db as never, { record: jest.fn() } as never), created };
}

const NAMES: Record<string, string> = {
  "s-1": "Chidi Obi",
  "p-1": "Amaka Obi",
  "p-2": "Emeka Obi",
  "p-3": "Ngozi Eze",
  "p-4": "Tunde Bello",
  "p-5": "Aunty Grace",
};

describe("the cap on guardians per pupil", () => {
  it("is not 2 — three is an ordinary family here, not an exception", () => {
    // Parents plus the local guardian a boarding pupil is actually contacted
    // through. If this ever becomes 2, that arrangement stops being expressible.
    expect(MAX_GUARDIANS_PER_STUDENT).toBeGreaterThanOrEqual(3);
  });

  it("is small enough to catch a runaway import", () => {
    expect(MAX_GUARDIANS_PER_STUDENT).toBeLessThanOrEqual(6);
  });

  it("allows a link while there is room", async () => {
    const { svc, created } = makeCapped([{ parentId: "p-1" }], NAMES);
    await svc.linkGuardian(admin, "p-2", "s-1");
    expect(created).toHaveLength(1);
  });

  it("refuses the one past the cap", async () => {
    const existing = ["p-1", "p-2", "p-3", "p-4"]
      .slice(0, MAX_GUARDIANS_PER_STUDENT)
      .map((parentId) => ({ parentId }));
    const { svc, created } = makeCapped(existing, NAMES);
    await expect(svc.linkGuardian(admin, "p-5", "s-1")).rejects.toBeInstanceOf(ConflictException);
    expect(created).toEqual([]);
  });

  it("NAMES who is already attached, so the office is not swapping blind", async () => {
    // The whole point. "Maximum reached" invites unlinking whoever is at the
    // top of the list; the four names make it a decision about people.
    const existing = ["p-1", "p-2", "p-3", "p-4"]
      .slice(0, MAX_GUARDIANS_PER_STUDENT)
      .map((parentId) => ({ parentId }));
    const { svc } = makeCapped(existing, NAMES);
    await expect(svc.linkGuardian(admin, "p-5", "s-1")).rejects.toThrow(/Amaka Obi/);
    await expect(svc.linkGuardian(admin, "p-5", "s-1")).rejects.toThrow(/Remove one/i);
  });

  it("counts THIS pupil's guardians, not the parent's other children", async () => {
    // The lookup is by studentId. A parent with four children is normal and
    // must not be blocked from being linked to a fifth.
    const { svc, created } = makeCapped([{ parentId: "p-1" }], NAMES);
    await svc.linkGuardian(admin, "p-2", "s-1");
    expect(created).toHaveLength(1);
  });

  it("still refuses a duplicate before it counts anything", async () => {
    const { svc } = makeCapped([{ parentId: "p-1" }], NAMES);
    await expect(svc.linkGuardian(admin, "p-1", "s-1")).rejects.toThrow(/already linked/i);
  });
});

describe("the web agrees with the server about the number", () => {
  const CARD = readFileSync(
    join(__dirname, "../../../web/components/sis/GuardianLinks.tsx"),
    "utf8",
  );

  it("reads the same constant rather than typing a number", () => {
    expect(CARD).toMatch(/MAX_GUARDIANS_PER_STUDENT/);
    expect(CARD).not.toMatch(/>= 4|of 4 linked/);
  });

  it("stops offering the form at the cap instead of letting it be refused", () => {
    expect(CARD).toMatch(/rows\.length >= MAX_GUARDIANS_PER_STUDENT \?/);
  });
});
