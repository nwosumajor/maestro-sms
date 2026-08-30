// =============================================================================
// Nothing could say who a pupil's parent was
// =============================================================================
// `parent_child` decides everything that matters — who receives the absence
// alert, the fee notice and the report card; whose "My children" page shows this
// pupil; which invoices a parent may open. The class page can CREATE a link.
//
// No surface could read one back. Found by probing every claim the product makes
// against the running system: a staff member looking at a pupil could not see
// which parent account was attached, nor how to reach it, so "we never received
// the invoice" had no answer inside the product.
//
// It is not the emergency-contact record. Those are people to telephone, typed
// in as free text. This is the ACCOUNT the system actually sends to.
// =============================================================================

import { SisService } from "../../src/sis/sis.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const staff: Principal = {
  schoolId: "S",
  userId: "u-staff",
  roles: ["principal"],
  permissions: ["student.profile.read"],
};

function makeService(parents: Array<Record<string, unknown>>) {
  const audits: Array<{ action: string }> = [];
  const tx = {
    parentChild: { findMany: jest.fn(async () => parents.map((p) => ({ parentId: p.id }))) },
    user: { findMany: jest.fn(async () => parents), findFirst: jest.fn(async () => ({ id: "stu", name: "A Pupil" })) },
    enrollment: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    classSubjectTeacher: { findMany: jest.fn().mockResolvedValue([]) },
    class: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = {
    record: jest.fn(async (e: { action: string }) => {
      audits.push(e);
    }),
  };
  return { svc: new SisService(db as never, audit as never, { enqueue: jest.fn() } as never), audits };
}

const parent = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  name: "Mrs Olawale",
  email: "mrs@olawale.test",
  contactEmail: null,
  loginEmailGenerated: false,
  phone: "+2348000000000",
  ...over,
});

describe("reading a pupil's guardians", () => {
  it("returns the linked parent accounts", async () => {
    const { svc } = makeService([parent()]);
    const rows = await svc.listGuardians(staff, "stu");
    expect(rows).toEqual([
      { id: "p-1", name: "Mrs Olawale", email: "mrs@olawale.test", phone: "+2348000000000", reachableByEmail: true },
    ]);
  });

  it("returns an empty list rather than failing when nobody is linked", async () => {
    // An unlinked pupil is a real and common state, and the screen says what it
    // means. It is not an error.
    const { svc } = makeService([]);
    expect(await svc.listGuardians(staff, "stu")).toEqual([]);
  });

  it("flags an account that cannot receive email", async () => {
    // A provisioned account can carry a GENERATED sign-in identifier rather than
    // a mailbox. Everything emailed to it disappears, and the sending side never
    // finds out — which is exactly why this is surfaced next to the name.
    const { svc } = makeService([parent({ email: "student.1234@generated.local", contactEmail: null, loginEmailGenerated: true })]);
    const rows = await svc.listGuardians(staff, "stu");
    expect(rows[0].reachableByEmail).toBe(false);
    expect(rows[0].email).toBeNull();
  });

  it("prefers the real contact address over the login identifier", async () => {
    const { svc } = makeService([
      parent({ email: "student.1234@generated.local", contactEmail: "real@family.test", loginEmailGenerated: true }),
    ]);
    expect((await svc.listGuardians(staff, "stu"))[0].email).toBe("real@family.test");
  });

  it("is audited — this is contact data about a family", async () => {
    // Golden Rule #5 puts a minor's record, and who is attached to it, in the
    // same category as the rest of it.
    const { svc, audits } = makeService([parent()]);
    await svc.listGuardians(staff, "stu");
    expect(audits.some((a) => a.action === "sis.guardians.read")).toBe(true);
  });

  it("goes through the same scope check as the rest of the record", async () => {
    const SRC = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../src/sis/sis.service.ts"),
      "utf8",
    ) as string;
    const fn = SRC.slice(SRC.indexOf("async listGuardians("), SRC.indexOf("async listGuardians(") + 900);
    expect(fn).toMatch(/assertCanAccessStudent\(tx, p, studentId\)/);
  });
});
