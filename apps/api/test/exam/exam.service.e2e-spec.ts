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
  const today = new Date().toISOString().slice(0, 10);
  const releaser = (): Principal => ({ userId: ADMIN, schoolId: SA, roles: ["principal"], permissions: ["exam.manage", "exam.release", "timetable.read"] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason: reactor signature is the engine's private FinalizedHandler
  let reactor: (tx: any, req: any) => Promise<void>;
  const tenantSvc = () => new PrismaTenantService();

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
    // Capture the maker-checker reactor so the test can fire it like the engine.
    const hooks = { onFinalized: (h: never) => { reactor = h as never; } };
    const workflow = { createRequest: jest.fn().mockResolvedValue({ id: "wf-1" }), submit: jest.fn().mockResolvedValue({}) };
    svc = new ExamService(tenant, audit, new NotificationService(tenant, audit, queue as never), workflow as never, hooks as never);
  });

  afterAll(async () => {
    for (const t of ["exam_invigilator", "exam_seat", "exam_sitting", "exam_schedule", "cbt_sitting", "cbt_exam", "cbt_question", "cbt_question_bank", "subject", "enrollment", "class", "user_role", "notification_delivery", "notification", "audit_log"]) {
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

  // --- schedule maker-checker + day-of release --------------------------------
  it("approves a whole schedule (head→principal) then releases a CBT sitting on the day", async () => {
    // A DRAFT CBT exam + bank to back a sitting.
    const bankId = randomUUID();
    const examId = randomUUID();
    const cbtSubjectId = randomUUID();
    await admin.query(`INSERT INTO subject (id,"schoolId",name,code,"updatedAt") VALUES ($1,$2,'Exam Subject','EXAMSUBJ',now())`, [cbtSubjectId, SA]);
    await admin.query(`INSERT INTO cbt_question_bank (id,"schoolId",name,"subjectId","createdById","updatedAt") VALUES ($1,$2,'Bank',$4,$3,now())`, [bankId, SA, ADMIN, cbtSubjectId]);
    await admin.query(`INSERT INTO cbt_question (id,"schoolId","bankId",prompt,choices,"answerIndex") VALUES ($1,$2,$3,'2+2?','["3","4"]'::jsonb,1)`, [randomUUID(), SA, bankId]);
    // classId set so AUTO-SEAT on approval fills the plan from the class roster.
    await admin.query(
      `INSERT INTO cbt_exam (id,"schoolId","bankId",title,"classId","questionCount","durationMinutes","startAt","endAt",status,"createdById","updatedAt")
       VALUES ($1,$2,$3,'Maths CBT',$4,1,30,now(),now()+interval '1 day','DRAFT',$5,now())`,
      [examId, SA, bankId, classId, ADMIN],
    );

    const sched = await svc.createSchedule(staff(), { title: "First Term Exams" });
    const sit = await svc.createSitting(staff(), { title: "Maths", date: today, startsAt: "09:00", endsAt: "10:00", hall: "Hall A", scheduleId: sched.id, cbtExamId: examId });

    // Submit for approval: schedule → PENDING_REVIEW, exam → PENDING_APPROVAL.
    const req = await svc.requestScheduleApproval(staff(), sched.id);
    expect(req.pendingApproval).toBe(true);
    let s = await admin.query(`SELECT status FROM exam_schedule WHERE id = $1`, [sched.id]);
    expect((s.rows[0] as { status: string }).status).toBe("PENDING_REVIEW");
    let e = await admin.query(`SELECT status, "releasedAt" FROM cbt_exam WHERE id = $1`, [examId]);
    expect((e.rows[0] as { status: string }).status).toBe("PENDING_APPROVAL");

    // Fire the finalized reactor (APPROVED) inside a tenant tx — like the engine.
    await tenantSvc().runAsTenant({ schoolId: SA, userId: ADMIN }, (tx) =>
      reactor(tx, { id: "wf-x", schoolId: SA, type: "EXAM_SCHEDULE_APPROVAL", state: "APPROVED", payload: { scheduleId: sched.id }, initiatorId: ADMIN }),
    );
    s = await admin.query(`SELECT status FROM exam_schedule WHERE id = $1`, [sched.id]);
    expect((s.rows[0] as { status: string }).status).toBe("APPROVED");
    e = await admin.query(`SELECT status, "releasedAt" FROM cbt_exam WHERE id = $1`, [examId]);
    expect((e.rows[0] as { status: string }).status).toBe("PUBLISHED");
    expect((e.rows[0] as { releasedAt: Date | null }).releasedAt).toBeNull(); // published but NOT yet open

    // AUTO-SEAT: approval filled the plan from the class roster (S1 + S2).
    const seatRows = await admin.query(`SELECT "seatNo" FROM exam_seat WHERE "sittingId" = $1 ORDER BY "seatNo"`, [sit.id]);
    expect(seatRows.rowCount).toBe(2);

    // Day-of release opens it (single authorized action) and AUTO-NOTIFIES the
    // seated students.
    const rel = await svc.releaseSitting(releaser(), sit.id);
    expect(rel.released).toBe(true);
    e = await admin.query(`SELECT "releasedAt" FROM cbt_exam WHERE id = $1`, [examId]);
    expect((e.rows[0] as { releasedAt: Date | null }).releasedAt).not.toBeNull();
    const notif = await admin.query(`SELECT "recipientId" FROM notification WHERE title = $1`, [`Exam open: Maths`]);
    expect(notif.rowCount).toBe(2); // S1 + S2 (no guardians linked in this fixture)

    // Releasing again is a no-op conflict (idempotent guard).
    await expect(svc.releaseSitting(releaser(), sit.id)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to release a paper (non-CBT) sitting", async () => {
    const paper = await svc.createSitting(staff(), { title: "Paper", date: today, startsAt: "09:00", endsAt: "10:00", hall: "Hall B" });
    await expect(svc.releaseSitting(releaser(), paper.id)).rejects.toMatchObject({ status: 400 });
  });
});
