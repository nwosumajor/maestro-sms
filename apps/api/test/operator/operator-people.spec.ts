// =============================================================================
// Per-school headcount — one definition, counted as PEOPLE
// =============================================================================
// This replaced three disagreeing implementations. Two were wrong, in opposite
// directions, and both were being read as audit figures:
//
//   • the fleet analytics used a hand-written allow-list of nine staff roles,
//     omitting warden, driver, head_warden, head_driver, librarian and
//     junior_admin — so every boarding school under-reported its staff;
//   • the school profile counted user_role ROWS, so a head teacher who also
//     teaches counted twice.
//
// The tests that matter are therefore: the definition covers EVERY seeded staff
// role (and keeps covering new ones), and people are counted once.
// =============================================================================

import { ROLE_PERMISSIONS, NON_SCHOOL_STAFF_ROLE_NAMES } from "@sms/types";
import { headcountBySchool, headcountInTenant } from "../../src/operator/operator-people";

const SCHOOL_A = "11111111-1111-1111-1111-111111111111";
const SCHOOL_B = "22222222-2222-2222-2222-222222222222";

/** Captures the SQL and replays canned rows, so we can assert on both. */
function mkClient(rows: Array<{ schoolId: string; students: number; staff: number; parents: number }>) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      $queryRaw: jest.fn(async (q: unknown) => {
        calls.push(q);
        return rows;
      }) as never,
    },
  };
}

describe("headcountBySchool", () => {
  it("returns a per-school split and asks the database ONCE", async () => {
    const { client } = mkClient([
      { schoolId: SCHOOL_A, students: 812, staff: 47, parents: 690 },
      { schoolId: SCHOOL_B, students: 120, staff: 11, parents: 98 },
    ]);
    const out = await headcountBySchool(client as never, [SCHOOL_A, SCHOOL_B]);

    expect(out.get(SCHOOL_A)).toEqual({ students: 812, staff: 47, parents: 690 });
    expect(out.get(SCHOOL_B)).toEqual({ students: 120, staff: 11, parents: 98 });
    // The whole point: two schools, one query. This replaced a per-school loop.
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("counts DISTINCT people, not role assignments", async () => {
    // The over-count bug: a head teacher who also teaches holds two staff roles and
    // is one member of staff. Asserted on the SQL, because the arithmetic happens
    // in Postgres — a test that only checked the returned numbers would pass against
    // the broken implementation too.
    const { client, calls } = mkClient([]);
    await headcountBySchool(client as never, [SCHOOL_A]);
    const sql = JSON.stringify(calls[0]);
    expect(sql).toContain("count(DISTINCT");
    expect(sql).not.toMatch(/count\(\*\)/);
  });

  it("does no work for an empty school list", async () => {
    const { client } = mkClient([]);
    await expect(headcountBySchool(client as never, [])).resolves.toEqual(new Map());
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it("reports zero for a school with no rows, never undefined", async () => {
    // A missing headcount must read as "no people", not crash a dashboard row.
    const { client } = mkClient([]);
    await expect(headcountInTenant(client as never, SCHOOL_A)).resolves.toEqual({ students: 0, staff: 0, parents: 0 });
  });
});

describe("the staff definition", () => {
  it("covers EVERY seeded school role", () => {
    // The regression this guards: an allow-list that silently stopped covering six
    // roles. Defined by exclusion against the seed's own role map, so a role added
    // tomorrow is counted without anybody remembering to update a list here.
    const seeded = Object.keys(ROLE_PERMISSIONS);
    const excluded = new Set<string>(NON_SCHOOL_STAFF_ROLE_NAMES);
    const staff = seeded.filter((r) => !excluded.has(r));

    // The six that the old hand-written list dropped.
    for (const role of ["warden", "driver", "head_warden", "head_driver", "librarian", "junior_admin"]) {
      expect(staff).toContain(role);
    }
    // And the ones that must never be counted as a school's staff.
    expect(staff).not.toContain("student");
    expect(staff).not.toContain("parent");
    // Platform roles belong to the operator's own org, not to a customer school.
    expect(staff).not.toContain("super_admin");
    expect(staff).not.toContain("manager_admin");
  });
});
