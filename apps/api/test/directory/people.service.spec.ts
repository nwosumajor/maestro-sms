// =============================================================================
// PeopleOptionsService — who a picker may show you
// =============================================================================
// The endpoint exists so that a parent can choose a teacher and an hr_clerk can
// choose a staff member, neither of whom holds class.write. Opening a people
// list to that many roles is only safe because of one rule, which is what this
// suite pins: a NON-STAFF caller sees staff and teachers, and nothing else.
// =============================================================================

import { PeopleOptionsService } from "../../src/directory/people.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const principal = (roles: string[]) =>
  ({ userId: "u1", schoolId: "s1", roles, permissions: [] }) as unknown as Principal;

function harness() {
  let where: Record<string, unknown> | null = null;
  let select: Record<string, unknown> | null = null;
  const tx = {
    user: {
      findMany: jest.fn((args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
        where = args.where;
        select = args.select;
        return Promise.resolve([{ id: "a", name: "Mrs Bello", roles: [{ role: { name: "teacher" } }] }]);
      }),
    },
  } as unknown as TenantTx;
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  return {
    svc: new PeopleOptionsService(db as never),
    get where() { return where; },
    get select() { return select; },
  };
}

/** The role filter a query ended up with, as JSON, for coarse assertions. */
const filterOf = (w: Record<string, unknown> | null) => JSON.stringify(w?.roles ?? {});

describe("PeopleOptionsService", () => {
  it("NEVER selects an email address", async () => {
    // The whole reason this endpoint is separate from GET /users. If a future
    // edit adds email to the select, this fails.
    const h = harness();
    await h.svc.list(principal(["school_admin"]), "staff");
    expect(Object.keys(h.select ?? {})).toEqual(["id", "name", "roles"]);
    expect(JSON.stringify(h.select)).not.toContain("email");
  });

  it("a parent asking for kind=parent still only gets STAFF", async () => {
    // The security rule. A parent must not be able to enumerate other parents,
    // and naming the kind explicitly must not be a way around it.
    const h = harness();
    await h.svc.list(principal(["parent"]), "parent");
    const f = filterOf(h.where);
    expect(f).toContain("notIn");
    expect(f).toContain("parent"); // present as an EXCLUSION
    expect(f).not.toContain('"name":"parent"'); // never as a positive filter
  });

  it("a parent asking kind=teacher gets TEACHERS, not every staff member", async () => {
    // The restriction NARROWS the requested kind; it must not replace it. When
    // it replaced it, the teacher picker on a parent's meeting request offered
    // the librarian, the driver and the accountant — safe, and wrong.
    const h = harness();
    await h.svc.list(principal(["parent"]), "teacher");
    expect(filterOf(h.where)).toContain('"name":"teacher"');
    expect(filterOf(h.where)).not.toContain("notIn");
  });

  it("a student is treated the same way", async () => {
    const h = harness();
    await h.svc.list(principal(["student"]), "parent");
    expect(filterOf(h.where)).toContain("notIn");
  });

  it("a staff caller CAN list parents — that is the point of the kind", async () => {
    // Guards against 'fixing' the rule by simply never returning parents, which
    // would break announcement addressing for admins.
    const h = harness();
    await h.svc.list(principal(["school_admin"]), "parent");
    expect(filterOf(h.where)).toContain('"name":"parent"');
  });

  it("a user holding BOTH a staff role and parent counts as staff", async () => {
    // A teacher whose own child attends the school. Treating them as non-staff
    // would silently strip their teaching pickers.
    const h = harness();
    await h.svc.list(principal(["teacher", "parent"]), "parent");
    expect(filterOf(h.where)).toContain('"name":"parent"');
  });

  it("searches by NAME only, never by email", async () => {
    // Matching on email would leak whether an address exists — the exact thing
    // withholding the field is meant to prevent.
    const h = harness();
    await h.svc.list(principal(["school_admin"]), "staff", "bello");
    expect(JSON.stringify(h.where)).toContain("bello");
    expect(JSON.stringify(h.where)).not.toContain("email");
  });

  it("returns id, name and roles", async () => {
    const h = harness();
    await expect(h.svc.list(principal(["teacher"]), "staff")).resolves.toEqual([
      { id: "a", name: "Mrs Bello", roles: ["teacher"] },
    ]);
  });
});
