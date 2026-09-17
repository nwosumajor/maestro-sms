// =============================================================================
// The fleet is a PREDICATE, not five thousand uuids
// =============================================================================
// Several cross-tenant operator reads mean "every customer school". They said so
// by fetching the ids once and spelling them back out to Postgres:
//
//     WHERE "schoolId" = ANY(ARRAY[${Prisma.join(customerIds)}]::uuid[])
//
// At the 5,000-school target that is a 195 KB SQL string per call, measured on
// that fixture at twice the cost of the equivalent subquery (12.7 ms planning /
// 33.3 ms execution against 4.2 / 20.6) — and it is the PLANNING half that grows
// with the fleet.
//
// Swapping a materialised list for a predicate is only safe if the predicate
// selects exactly the same schools, so that is what this proves, against a real
// database rather than by reading the SQL:
//
//   - ALL_CUSTOMER_SCHOOLS agrees, row for row, with the explicit id list;
//   - both predicates EXCLUDE the platform org, which is the one that would
//     silently fold the operator's own staff into a customer headcount;
//   - ACTIVE_CUSTOMER_SCHOOLS is the narrower of the two and says which;
//   - neither fragment carries a caller value, so it cannot widen a scope.
//
// Needs TEST_ADMIN_URL (superuser). These are the platform owner's own
// cross-tenant reads and run on the PRIVILEGED client in production, so the
// test drives them the same way.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Prisma } from "@sms/db";
import {
  ACTIVE_CUSTOMER_SCHOOLS,
  ALL_CUSTOMER_SCHOOLS,
  inSchoolScope,
  isEmptyScope,
} from "../../src/operator/operator-fleet";
import { headcountBySchool } from "../../src/operator/operator-people";

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = ADMIN_URL ? describe : describe.skip;

describe("the scope fragment itself", () => {
  it("parameterises an explicit list and inlines nothing", () => {
    const ids = [randomUUID(), randomUUID()];
    const frag = inSchoolScope(Prisma.sql`ur."schoolId"`, ids);
    // The ids travel as bound parameters, never as text in the statement.
    expect(frag.values).toEqual(ids);
    expect(frag.sql).not.toContain(ids[0]);
  });

  it("carries no caller value at all in the fleet form", () => {
    // A fragment with no parameters cannot be widened by what a caller passes.
    expect(inSchoolScope(Prisma.sql`ur."schoolId"`, ALL_CUSTOMER_SCHOOLS).values).toEqual([]);
    expect(inSchoolScope(Prisma.sql`ur."schoolId"`, ACTIVE_CUSTOMER_SCHOOLS).values).toEqual([]);
  });

  it("knows an empty list selects nothing, and a predicate never does", () => {
    // Prisma.join throws on an empty array; a predicate has no such shape, so
    // treating it as "empty" would silently skip a whole-fleet read.
    expect(isEmptyScope([])).toBe(true);
    expect(isEmptyScope([randomUUID()])).toBe(false);
    expect(isEmptyScope(ALL_CUSTOMER_SCHOOLS)).toBe(false);
  });
});

d("the fleet predicates, against a real database", () => {
  let admin: Pool;

  // A Prisma-shaped client over the superuser pool. Going through `q.text` and
  // `q.values` also proves the fragment really is parameterised — one that
  // inlined its ids would arrive here with the wrong placeholder count.
  // GOTCHA: `Prisma.Sql` exposes the statement TWICE — `.sql` carries `?`
  // placeholders and `.text` carries `$1…`. Postgres only accepts the latter,
  // and handing it `.sql` fails as a syntax error pointing at the comma.
  const client = {
    $queryRaw: (async (q: Prisma.Sql) => (await admin.query(q.text, q.values)).rows) as never,
  };

  const PLATFORM = randomUUID();
  const ACTIVE_A = randomUUID();
  const ACTIVE_B = randomUUID();
  const DISABLED_C = randomUUID();
  const customers = [ACTIVE_A, ACTIVE_B, DISABLED_C];
  const tag = `fleet-${Date.now()}`;
  const users: string[] = [];

  async function school(id: string, isPlatform: boolean, status: string) {
    await admin.query(
      `INSERT INTO school (id, name, slug, status, "isPlatform", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, `${tag}-${id.slice(0, 8)}`, `${tag}-${id.slice(0, 8)}`, status, isPlatform],
    );
  }

  async function person(schoolId: string, roleName: string) {
    const id = randomUUID();
    users.push(id);
    await admin.query(
      `INSERT INTO "user" (id, "schoolId", email, name, "passwordHash", status, "updatedAt")
       VALUES ($1, $2, $3, $4, 'x', 'ACTIVE', now())`,
      [id, schoolId, `${id}@${tag}.test`, `${tag} person`],
    );
    // GOTCHA: `INSERT … SELECT` matching no role inserts NOTHING and reports
    // success. The first version of this fixture put the platform org's person
    // on a role the test database has never seeded, so the org had no rows at
    // all — and the test then passed against a deliberately broken predicate,
    // proving only that the fixture was empty.
    const put = await admin.query(
      `INSERT INTO user_role (id, "schoolId", "userId", "roleId")
       SELECT $1, $2, $3, r.id FROM role r WHERE r.name = $4`,
      [randomUUID(), schoolId, id, roleName],
    );
    if (put.rowCount !== 1) throw new Error(`no role named ${roleName} in this database`);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await school(PLATFORM, true, "ACTIVE");
    await school(ACTIVE_A, false, "ACTIVE");
    await school(ACTIVE_B, false, "ACTIVE");
    await school(DISABLED_C, false, "DISABLED");

    // Any role will do — what is under test is the SCHOOL filter, not the role.
    await person(PLATFORM, "teacher");
    await person(ACTIVE_A, "student");
    await person(ACTIVE_A, "student");
    await person(ACTIVE_A, "teacher");
    await person(ACTIVE_B, "student");
    await person(DISABLED_C, "student");
  });

  afterAll(async () => {
    // Scoped by id, never by a predicate that could reach a real row.
    await admin.query(`DELETE FROM user_role WHERE "userId" = ANY($1::uuid[])`, [users]);
    await admin.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [users]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1::uuid[])`, [[PLATFORM, ...customers]]);
    await admin.end();
  });

  it("selects exactly what the explicit id list selected", async () => {
    // The whole justification for the swap. If these ever disagree, a fleet
    // total quietly starts answering a different question from a paged one.
    const byList = await headcountBySchool(client, customers);
    const byPredicate = await headcountBySchool(client, ALL_CUSTOMER_SCHOOLS);

    for (const id of customers) {
      expect(byPredicate.get(id)).toEqual(byList.get(id));
    }
    expect(byList.get(ACTIVE_A)).toMatchObject({ students: 2, staff: 1 });
    expect(byList.get(ACTIVE_B)).toMatchObject({ students: 1 });
    expect(byList.get(DISABLED_C)).toMatchObject({ students: 1 });
  });

  it("leaves the platform org out of every customer figure", async () => {
    // The operator's own staff are not a customer's headcount. Dropping
    // `isPlatform = false` would add them to a fleet total in silence.
    const all = await headcountBySchool(client, ALL_CUSTOMER_SCHOOLS);
    const active = await headcountBySchool(client, ACTIVE_CUSTOMER_SCHOOLS);
    expect(all.has(PLATFORM)).toBe(false);
    expect(active.has(PLATFORM)).toBe(false);
  });

  it("narrows to switched-on schools, and says which it dropped", async () => {
    // Two fleets, deliberately different: the analytics roll-up counts every
    // customer, the attention queue only chases the ones still trading.
    const all = await headcountBySchool(client, ALL_CUSTOMER_SCHOOLS);
    const active = await headcountBySchool(client, ACTIVE_CUSTOMER_SCHOOLS);
    expect(all.has(DISABLED_C)).toBe(true);
    expect(active.has(DISABLED_C)).toBe(false);
    expect(active.has(ACTIVE_A)).toBe(true);
    expect(active.has(ACTIVE_B)).toBe(true);
  });
});
