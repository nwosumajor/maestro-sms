// =============================================================================
// The operator directory named the admin who had left
// =============================================================================
// `contactsIn` supplies the name, email and phone the PLATFORM OWNER rings — to
// chase an overdue subscription, answer an onboarding question, warn about a
// chargeback. It had no status filter and took the EARLIEST-appointed holder.
//
// A staff exit deliberately keeps the `user_role` row (it is employment history;
// auth refuses the login instead), so the directory went on naming whoever was
// appointed first whether or not they still work there.
//
// Measured live on the running stack: a school whose founding admin had left and
// whose current admin was appointed afterwards was listed as `admin=Demo Admin`
// — the departed one — with the active one not shown at all. And an EXITED user
// cannot authenticate, so an email to them lands in an inbox its owner can no
// longer open, and the sender is told it was delivered.
// =============================================================================

import { OperatorDirectoryService } from "../../src/operator/operator-directory.service";
import { STILL_HERE } from "../../src/common/still-here";

type Holder = {
  role: { name: string };
  user: { name: string; email: string; phone: string | null; status: string };
};

/** Reads the where-clause the service actually sends, and the rows it keeps. */
function contactsFor(holders: Holder[]): {
  where: Record<string, unknown>;
  result: Promise<{ admins: Array<{ name: string }>; principals: Array<{ name: string }> }>;
} {
  let seen: Record<string, unknown> = {};
  const tx = {
    userRole: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        seen = args.where;
        // Model the database honestly: the filter is applied by Postgres.
        const status = (args.where as { user?: { status?: string } }).user?.status;
        return holders.filter((h) => (status ? h.user.status === status : true));
      },
    },
  };
  const svc = Object.create(OperatorDirectoryService.prototype) as OperatorDirectoryService;
  const call = (svc as unknown as {
    contactsIn: (t: unknown) => Promise<{ admins: Array<{ name: string }>; principals: Array<{ name: string }> }>;
  }).contactsIn.call(svc, tx);
  return { where: seen, result: call };
}

const departed: Holder = {
  role: { name: "school_admin" },
  user: { name: "Founding Admin", email: "gone@school", phone: null, status: "EXITED" },
};
const current: Holder = {
  role: { name: "school_admin" },
  user: { name: "Current Admin", email: "here@school", phone: null, status: "ACTIVE" },
};

describe("a contact who still works there", () => {
  it("asks the database for people who are still here", async () => {
    const { where, result } = contactsFor([departed, current]);
    await result;
    expect(where).toMatchObject({ user: STILL_HERE });
  });

  it("names the CURRENT admin, not the one appointed first and since gone", async () => {
    const { result } = contactsFor([departed, current]);
    const { admins } = await result;
    expect(admins.map((a) => a.name)).toEqual(["Current Admin"]);
  });

  it("reports NOBODY rather than falling back to a leaver", async () => {
    // A school with no reachable admin is a fact the operator needs. A name that
    // cannot be reached is worse than a blank, because it gets dialled.
    const { result } = contactsFor([departed]);
    const { admins } = await result;
    expect(admins).toEqual([]);
  });

  it("still separates admins from principals", async () => {
    const principal: Holder = {
      role: { name: "principal" },
      user: { name: "The Principal", email: "p@school", phone: "+234", status: "ACTIVE" },
    };
    const { result } = contactsFor([current, principal]);
    const { admins, principals } = await result;
    expect(admins.map((a) => a.name)).toEqual(["Current Admin"]);
    expect(principals.map((a) => a.name)).toEqual(["The Principal"]);
  });
});
