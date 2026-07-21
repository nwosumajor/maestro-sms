// =============================================================================
// ReportCardRemarkService — class-teacher + head remark scoping (real DB)
// =============================================================================
// Proves: a class teacher of the student's class can set the class-teacher
// remark but NOT the head remark; an unrelated teacher can set NEITHER; the
// principal sets both; reads are report-card scoped (guardian yes, unrelated
// parent 404); upsert keeps one row per (student, term).
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { ReportCardRemarkService } from "../../src/reportcards/report-card-remark.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("ReportCardRemarkService scoping (real Postgres)", () => {
  let admin: Pool;
  let svc: ReportCardRemarkService;

  const SA = randomUUID();
  const PRINCIPAL = randomUUID();
  const CLASS_TEACHER = randomUUID(); // teaches the student's class
  const OTHER_TEACHER = randomUUID(); // teaches a different class
  const GUARDIAN = randomUUID();
  const OTHER_PARENT = randomUUID();
  const STUDENT = randomUUID();
  const classId = randomUUID();
  const otherClassId = randomUUID();
  const sessionId = randomUUID();
  const termId = randomUUID();

  const principal = (): Principal => ({ userId: PRINCIPAL, schoolId: SA, roles: ["principal"], permissions: [] });
  const classTeacher = (): Principal => ({ userId: CLASS_TEACHER, schoolId: SA, roles: ["teacher"], permissions: [] });
  const otherTeacher = (): Principal => ({ userId: OTHER_TEACHER, schoolId: SA, roles: ["teacher"], permissions: [] });
  const guardian = (): Principal => ({ userId: GUARDIAN, schoolId: SA, roles: ["parent"], permissions: [] });
  const otherParent = (): Principal => ({ userId: OTHER_PARENT, schoolId: SA, roles: ["parent"], permissions: [] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RM',$2,now())`, [SA, "rm-" + SA]);
    for (const [u, name] of [
      [PRINCIPAL, "Principal"],
      [CLASS_TEACHER, "Class Teacher"],
      [OTHER_TEACHER, "Other Teacher"],
      [GUARDIAN, "Guardian"],
      [OTHER_PARENT, "Other Parent"],
      [STUDENT, "Rm Student"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@rm", name],
      );
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, GUARDIAN, STUDENT]);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'JSS1',now()),($3,$2,'JSS2',now())`, [classId, SA, otherClassId]);
    await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, classId, STUDENT]);
    await admin.query(`INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, classId, CLASS_TEACHER]);
    await admin.query(`INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, otherClassId, OTHER_TEACHER]);
    await admin.query(`INSERT INTO academic_session (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'2025/2026',now())`, [sessionId, SA]);
    await admin.query(`INSERT INTO term (id,"schoolId","sessionId",name,sequence,"updatedAt") VALUES ($1,$2,$3,'First Term',1,now())`, [termId, SA, sessionId]);

    svc = new ReportCardRemarkService(new PrismaTenantService() as never, new AuditLogService());
  });

  afterAll(async () => {
    for (const t of ["report_card_remark", "term", "academic_session", "class_teacher", "enrollment", "class", "parent_child", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("the class teacher sets the class-teacher remark but CANNOT set the head remark", async () => {
    const r = await svc.setClassTeacherRemark(classTeacher(), STUDENT, termId, "A diligent, well-behaved student.");
    expect(r.classTeacherRemark).toBe("A diligent, well-behaved student.");
    await expect(svc.setHeadRemark(classTeacher(), STUDENT, termId, "nope")).rejects.toMatchObject({ status: 403 });
  });

  it("a teacher who does NOT teach the student can set NEITHER remark", async () => {
    await expect(svc.setClassTeacherRemark(otherTeacher(), STUDENT, termId, "x")).rejects.toMatchObject({ status: 403 });
    await expect(svc.setHeadRemark(otherTeacher(), STUDENT, termId, "x")).rejects.toMatchObject({ status: 403 });
  });

  it("the principal sets the head remark; both remarks live on ONE row (upsert)", async () => {
    const r = await svc.setHeadRemark(principal(), STUDENT, termId, "Promoted to the next class.");
    expect(r.headRemark).toBe("Promoted to the next class.");
    expect(r.classTeacherRemark).toBe("A diligent, well-behaved student."); // preserved
    const rows = await admin.query(`SELECT count(*)::int AS n FROM report_card_remark WHERE "studentId" = $1 AND "termId" = $2`, [STUDENT, termId]);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it("reads are report-card scoped: guardian sees them, an unrelated parent gets 404", async () => {
    const seen = await svc.get(guardian(), STUDENT, termId);
    expect(seen.headRemark).toBe("Promoted to the next class.");
    await expect(svc.get(otherParent(), STUDENT, termId)).rejects.toMatchObject({ status: 404 });
  });
});
