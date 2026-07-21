// =============================================================================
// AuthService — per-school "require staff MFA" login enforcement (real DB)
// =============================================================================
// Proves that School.requireStaffMfa flags mfaEnrollRequired at login for a
// STAFF member who hasn't enrolled TOTP, does NOT flag a student/parent, and
// does NOT flag once MFA is enabled. The login still SUCCEEDS (the user needs a
// session to reach the MFA setup page) — the claim just carries the mandate.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@sms/db";
import { AuthService } from "../../src/foundation/auth.service";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("AuthService requireStaffMfa policy (real Postgres)", () => {
  let admin: Pool;
  let auth: AuthService;

  const SA = randomUUID();
  const TEACHER = randomUUID();
  const STUDENT = randomUUID();
  const teacherRoleId = randomUUID();
  const studentRoleId = randomUUID();

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,status,"requireStaffMfa","updatedAt") VALUES ($1,'MF',$2,'ACTIVE',true,now())`, [SA, "mf-" + SA]);
    const hash = await bcrypt.hash("password123", 10);
    for (const [u, name] of [[TEACHER, "Teacher"], [STUDENT, "Student"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","passwordChangedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [u, SA, u + "@mf", name, hash],
      );
    }
    // Reuse seeded roles where present, else create.
    const t = await admin.query(`SELECT id FROM role WHERE name='teacher'`);
    const st = await admin.query(`SELECT id FROM role WHERE name='student'`);
    const tid = t.rowCount ? (t.rows[0] as { id: string }).id : teacherRoleId;
    const sid = st.rowCount ? (st.rows[0] as { id: string }).id : studentRoleId;
    if (!t.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'teacher')`, [teacherRoleId]);
    if (!st.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'student')`, [studentRoleId]);
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, TEACHER, tid]);
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, STUDENT, sid]);

    const tenant = new PrismaTenantService() as never;
    auth = new AuthService(tenant, new ModuleEntitlementService(tenant));
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM user_role WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM role WHERE id = ANY($1)`, [[teacherRoleId, studentRoleId]]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("a staff member (teacher) without MFA is flagged mfaEnrollRequired, but login still succeeds", async () => {
    const res = await auth.login(TEACHER + "@mf", "password123");
    expect(res.mfaEnrollRequired).toBe(true);
    expect(res.userId).toBe(TEACHER);
  });

  it("a student is NOT subject to the staff-MFA policy", async () => {
    const res = await auth.login(STUDENT + "@mf", "password123");
    expect(res.mfaEnrollRequired).toBe(false);
  });

  it("with the policy OFF, staff are no longer flagged", async () => {
    await admin.query(`UPDATE school SET "requireStaffMfa" = false WHERE id = $1`, [SA]);
    const res = await auth.login(TEACHER + "@mf", "password123");
    expect(res.mfaEnrollRequired).toBe(false);
    await admin.query(`UPDATE school SET "requireStaffMfa" = true WHERE id = $1`, [SA]);
  });
});
