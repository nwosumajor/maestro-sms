// =============================================================================
// The fleet headcount, against a real Postgres: PEOPLE, counted once, on roll
// =============================================================================
// `headcountBySchool` feeds the operator's registry, directory, school profile
// and fleet analytics. It was rewritten for speed: `count(DISTINCT userId)` on
// all three figures made Postgres sort the whole fleet's role rows (3.3 s at
// 5,000 schools / 2.5M pupils). Pupils and parents are now counted with
// `count(*)` — correct ONLY because `user_role` is UNIQUE on (userId, roleId) —
// and staff are de-duplicated on their own.
//
// The two unit tests this replaces asserted on the SQL's SPELLING
// (`count(DISTINCT`, a FILTER per category), so they could only ever vouch for
// one way of writing it. This drives the real function over real rows, so it
// holds for any SQL that gets the answer right and fails for any that does not:
//   - a person holding two staff roles is ONE member of staff;
//   - a person who is parent AND teacher counts once in each, by design;
//   - a leaver is not headcount, whether pupil, parent or staff;
//   - a school with staff and nobody else on roll still appears.
//
// Runs as the privileged role, as the service does (the privileged client
// reads across tenants). Needs TEST_ADMIN_URL — `pnpm --filter @sms/api
// test:db` supplies it.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PrismaClient } from "@sms/db";
import { headcountBySchool } from "../../src/operator/operator-people";
import { ALL_CUSTOMER_SCHOOLS } from "../../src/operator/operator-fleet";

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = ADMIN_URL ? describe : describe.skip;

d("headcountBySchool (real Postgres)", () => {
  let admin: Pool;
  let client: PrismaClient;

  const SA = randomUUID();
  const SB = randomUUID();
  const people: Array<{ id: string; school: string; status: string; roles: string[] }> = [
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["teacher", "principal"] }, // ONE member of staff
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["teacher"] },
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["parent", "teacher"] }, // parent AND staff
    { id: randomUUID(), school: SA, status: "EXITED", roles: ["teacher"] }, // a leaver
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["student"] },
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["student"] },
    { id: randomUUID(), school: SA, status: "EXITED", roles: ["student"] }, // a leaver
    { id: randomUUID(), school: SA, status: "ACTIVE", roles: ["parent"] },
    { id: randomUUID(), school: SA, status: "EXITED", roles: ["parent"] }, // a leaver
    { id: randomUUID(), school: SB, status: "ACTIVE", roles: ["teacher"] }, // staff, nobody else
  ];

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    client = new PrismaClient({ datasourceUrl: ADMIN_URL });
    for (const s of [SA, SB]) {
      await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'HC',$2,now())`, [s, "hc-" + s]);
    }
    for (const p of people) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash",status,"updatedAt") VALUES ($1,$2,$3,'HC','x',$4,now())`,
        [p.id, p.school, `${p.id}@hc.test`, p.status],
      );
      for (const role of p.roles) {
        await admin.query(
          `INSERT INTO user_role (id,"schoolId","userId","roleId") SELECT $1,$2,$3,id FROM role WHERE name = $4`,
          [randomUUID(), p.school, p.id, role],
        );
      }
    }
    // A fixture whose roles silently failed to insert would make every
    // assertion below vacuous.
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM user_role WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    expect(rows[0].n).toBe(people.reduce((n, p) => n + p.roles.length, 0));
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM user_role WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await client.$disconnect();
    await admin.end();
  });

  it("counts people once, and only those still on roll", async () => {
    const out = await headcountBySchool(client, [SA, SB]);
    // staff: the two-role teacher once, the other teacher, the parent-teacher.
    // Not the leaver. Pupils and parents: the leavers are not counted either.
    expect(out.get(SA)).toEqual({ students: 2, staff: 3, parents: 2 });
  });

  it("keeps a school that has staff and nobody else on roll", async () => {
    const out = await headcountBySchool(client, [SA, SB]);
    expect(out.get(SB)).toEqual({ students: 0, staff: 1, parents: 0 });
  });

  it("gives the same figures through the fleet predicate as through an explicit list", async () => {
    const byList = await headcountBySchool(client, [SA, SB]);
    const byFleet = await headcountBySchool(client, ALL_CUSTOMER_SCHOOLS);
    expect(byFleet.get(SA)).toEqual(byList.get(SA));
    expect(byFleet.get(SB)).toEqual(byList.get(SB));
  });
});
