// =============================================================================
// ExamService — sittings, seating, invigilation (real DB)
// =============================================================================
// Proves: create a sitting; auto-seat a class (seat 1..N); a student sees their
// OWN seat + hall + time; assign an invigilator (staff-only, notified) and see
// their duties; capacity is enforced; deleting a sitting cascades.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { ExamService } from "../../src/exam/exam.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("ExamService (real Postgres)", () => {
  let admin: Pool;
  let svc: ExamService;

  const SA = randomUUID();
  const ADMIN = randomUUID();
  const TEACHER = randomUUID();
  const S1 = randomUUID();
  const S2 = randomUUID();
  const classId = randomUUID();
  const teacherRoleId = randomUUID();
  const studentRoleId = randomUUID();

  const staff = (): Principal => ({ userId: ADMIN, schoolId: SA, roles: ["school_admin"], permissions: ["exam.manage", "timetable.read"] });
  const student = (): Principal => ({ userId: S1, schoolId: SA, roles: ["student"], permissions: ["timetable.read"] });
  const teacher = (): Principal => ({ userId: TEACHER, schoolId: SA, roles: ["teacher"], permissions: ["timetable.read"] });

  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'EX',$2,now())`, [SA, "ex-" + SA]);
    for (const [u, name] of [[ADMIN, "Admin"], [TEACHER, "Teacher"], [S1, "Student One"], [S2, "Student Two"]] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@ex", name]);
    }
    const te = await admin.query(`SELECT id FROM role WHERE name='teacher'`);
    const st = await admin.query(`SELECT id FROM role WHERE name='student'`);
    const tid = te.rowCount ? (te.rows[0] as { id: string }).id : teacherRoleId;
    const sid = st.rowCount ? (st.rows[0] as { id: string }).id : studentRoleId;
    if (!te.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'teacher')`, [teacherRoleId]);
    if (!st.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'student')`, [studentRoleId]);
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, TEACHER, tid]);
    for (const s of [S1, S2]) await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, s, sid]);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'JSS3',now())`, [classId, SA]);
    for (const s of [S1, S2]) await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, classId, s]);

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    svc = new ExamService(tenant, audit, new NotificationService(tenant, audit, queue as never));
  });

  afterAll(async () => {
    for (const t of ["exam_invigilator", "exam_seat", "exam_sitting", "enrollment", "class", "user_role", "notification_delivery", "notification", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM role WHERE id = ANY($1)`, [[teacherRoleId, studentRoleId]]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  let sittingId = "";

  it("creates a sitting and auto-seats a class 1..N", async () => {
    const sit = await svc.createSitting(staff(), { title: "Mathematics", date: soon, startsAt: "09:00", endsAt: "11:00", hall: "Main Hall", capacity: 50 });
    sittingId = sit.id;
    const seats = await svc.seatClass(staff(), sittingId, classId);
    expect(seats).toHaveLength(2);
    expect(seats.map((s) => s.seatNo).sort()).toEqual([1, 2]);
  });

  it("a student sees their own upcoming exam with seat, hall and time", async () => {
    const mine = await svc.myExams(student());
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Mathematics", hall: "Main Hall", startsAt: "09:00" });
    expect(mine[0].seatNo).toBeGreaterThan(0);
  });

  it("assigns an invigilator (staff-only, notified) who then sees the duty", async () => {
    await svc.assignInvigilator(staff(), sittingId, TEACHER, true);
    await expect(svc.assignInvigilator(staff(), sittingId, S1, false)).rejects.toMatchObject({ status: 400 }); // a student can't invigilate
    const notif = await admin.query(`SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Invigilation duty assigned'`, [TEACHER]);
    expect(notif.rowCount).toBe(1);
    const duties = await svc.myInvigilations(teacher());
    expect(duties).toHaveLength(1);
    expect(duties[0].title).toBe("Mathematics");
  });

  it("enforces hall capacity", async () => {
    const small = await svc.createSitting(staff(), { title: "Tiny", date: soon, startsAt: "12:00", endsAt: "13:00", hall: "Room 1", capacity: 1 });
    await expect(svc.seat(staff(), small.id, [S1, S2])).rejects.toMatchObject({ status: 409 });
  });

  it("deleting a sitting cascades its seats + invigilators", async () => {
    await svc.deleteSitting(staff(), sittingId);
    expect(await svc.myExams(student())).toHaveLength(0);
    const seatRows = await admin.query(`SELECT id FROM exam_seat WHERE "sittingId" = $1`, [sittingId]);
    expect(seatRows.rowCount).toBe(0);
  });
});
