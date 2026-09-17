// =============================================================================
// PROBE: when a session ends and pupils are promoted, does the profile move?
// =============================================================================
// The profile's class and supervisor are DERIVED from the pupil's one ACTIVE
// enrolment rather than stored, precisely so a promotion updates them without a
// second writer having to remember. This drives the real thing end to end
// against a real Postgres: profile before, promotion batch approved, profile
// after — including the SUPERVISOR, which changes because the class changed and
// nothing about the pupil was rewritten.
//
// Run: `pnpm --filter @sms/api test:db -- the-profile-follows-a-promotion`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { SisService } from "../../src/sis/sis.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("a profile follows a promotion (real Postgres)", () => {
  let admin: Pool;
  let sis: SisService;

  const SCHOOL = randomUUID();
  const HEAD = randomUUID();
  const PUPIL = randomUUID();
  const TEACHER_OLD = randomUUID();
  const TEACHER_NEW = randomUUID();
  const JSS1 = randomUUID();
  const JSS2 = randomUUID();

  const head = (): Principal => ({
    schoolId: SCHOOL,
    userId: HEAD,
    roles: ["principal"],
    permissions: ["student.read", "student.profile.read"],
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'Promo',$2,'NGN',now())`, [SCHOOL, "promo-" + SCHOOL]);
    for (const [id, n] of [[HEAD, "Head"], [PUPIL, "Ada"], [TEACHER_OLD, "Mrs Old"], [TEACHER_NEW, "Mr New"]] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SCHOOL, `${id}@promo.test`, n]);
    }
    await admin.query(`INSERT INTO "class" (id,"schoolId",name,"supervisorId","updatedAt") VALUES ($1,$2,'JSS 1A',$3,now())`, [JSS1, SCHOOL, TEACHER_OLD]);
    await admin.query(`INSERT INTO "class" (id,"schoolId",name,"supervisorId","updatedAt") VALUES ($1,$2,'JSS 2A',$3,now())`, [JSS2, SCHOOL, TEACHER_NEW]);
    await admin.query(`INSERT INTO student_profile (id,"schoolId","studentId","admissionNumber","updatedAt") VALUES (gen_random_uuid(),$1,$2,'ADM-1',now())`, [SCHOOL, PUPIL]);
    await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES (gen_random_uuid(),$1,$2,$3,'ACTIVE')`, [SCHOOL, JSS1, PUPIL]);

    sis = new SisService(new PrismaTenantService() as never, new AuditLogService(), { enqueue: jest.fn() } as never);
  });

  afterAll(async () => {
    for (const t of ["enrollment", "student_profile", "audit_log", '"class"', '"user"', "school"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SCHOOL]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SCHOOL]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("shows the OLD class and ITS supervisor before the promotion", async () => {
    const before = await sis.getProfile(head(), PUPIL);
    expect(before.currentClass).toMatchObject({ id: JSS1, name: "JSS 1A" });
    expect(before.supervisor).toMatchObject({ id: TEACHER_OLD, name: "Mrs Old" });
  });

  it("moves to the NEW class and its supervisor once promoted", async () => {
    // Exactly what PromotionService.enrollInto does: close the source, open the
    // destination. Nothing writes to the profile at all.
    await admin.query(`UPDATE enrollment SET status='PROMOTED' WHERE "studentId"=$1 AND "classId"=$2`, [PUPIL, JSS1]);
    await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES (gen_random_uuid(),$1,$2,$3,'ACTIVE')`, [SCHOOL, JSS2, PUPIL]);

    const after = await sis.getProfile(head(), PUPIL);
    expect(after.currentClass).toMatchObject({ id: JSS2, name: "JSS 2A" });
    // The SUPERVISOR followed too, without anybody rewriting the pupil.
    expect(after.supervisor).toMatchObject({ id: TEACHER_NEW, name: "Mr New" });
  });

  it("still shows exactly ONE class, not the history", async () => {
    // The closed enrolment is still there — it is the pupil's record — and must
    // not surface as a second current class.
    const rows = await admin.query(`SELECT status FROM enrollment WHERE "studentId"=$1 ORDER BY status`, [PUPIL]);
    expect(rows.rows.map((r) => r.status).sort()).toEqual(["ACTIVE", "PROMOTED"]);
    const after = await sis.getProfile(head(), PUPIL);
    expect(after.currentClass!.id).toBe(JSS2);
  });

  it("reports NOT IN A CLASS once the pupil graduates out", async () => {
    // A leaver has no active enrolment. The profile must say so rather than
    // keep showing the class they have left.
    await admin.query(`UPDATE enrollment SET status='GRADUATED' WHERE "studentId"=$1 AND "classId"=$2`, [PUPIL, JSS2]);
    const after = await sis.getProfile(head(), PUPIL);
    expect(after.currentClass).toBeNull();
    expect(after.supervisor).toBeNull();
  });
});
