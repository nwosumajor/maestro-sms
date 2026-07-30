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
    // `room` comes AFTER exam_sitting: a sitting references it (ON DELETE SET NULL,
    // so it would not block, but leaving the room behind would block the school).
    // Every tenant table now FKs to school, so a missed child fails the teardown
    // loudly instead of leaving an unreachable orphan row — which is exactly how
    // this line came to be needed.
    for (const t of ["exam_invigilator", "exam_seat", "exam_sitting", "exam_schedule", "cbt_sitting", "cbt_exam", "cbt_question", "cbt_question_bank", "subject", "room", "enrollment", "class", "user_role", "notification_delivery", "notification", "audit_log"]) {
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

  // ===========================================================================
  // Exam console: non-destructive edit, clash detection, bulk seating, day board
  // ===========================================================================
  // A distinct date so these never interact with the fixtures above.
  const planDay = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  it("EDIT preserves the seating plan and the invigilator roster", async () => {
    // This is the whole point of PATCH existing. Before it, correcting a sitting
    // meant delete + recreate, and delete cascades seats + invigilators — so
    // moving an exam by 30 minutes silently destroyed a class's seating plan and
    // a roster staff had already been notified about.
    const sit = await svc.createSitting(staff(), {
      title: "Chemistry",
      date: planDay,
      startsAt: "09:00",
      endsAt: "11:00",
      hall: "Lab 1",
      capacity: 40,
    });
    await svc.seatClass(staff(), sit.id, classId);
    await svc.assignInvigilator(staff(), sit.id, TEACHER, true);

    const edited = await svc.updateSitting(staff(), sit.id, { startsAt: "09:30", endsAt: "11:30", title: "Chemistry Paper 1" });

    expect(edited.startsAt).toBe("09:30");
    expect(edited.title).toBe("Chemistry Paper 1");
    // The survivors — reported on the returned row AND verified in the DB.
    expect(edited.seated).toBe(2);
    expect(edited.invigilators).toBe(1);
    const seats = await admin.query(`SELECT "seatNo" FROM exam_seat WHERE "sittingId" = $1 ORDER BY "seatNo"`, [sit.id]);
    expect(seats.rows.map((r) => (r as { seatNo: number }).seatNo)).toEqual([1, 2]);
    const invs = await admin.query(`SELECT "staffId" FROM exam_invigilator WHERE "sittingId" = $1`, [sit.id]);
    expect(invs.rowCount).toBe(1);

    // The audit entry records what it USED to be — the only question ever asked
    // after an exam moves.
    const log = await admin.query(
      `SELECT metadata FROM audit_log WHERE action = 'exam.sitting.update' AND "entityId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [sit.id],
    );
    const changed = (log.rows[0] as { metadata: { changed: Record<string, { from: string; to: string }> } }).metadata.changed;
    expect(changed.startsAt).toEqual({ from: "09:00", to: "09:30" });
  });

  it("refuses a hall double-booking (409) but allows back-to-back in the same hall", async () => {
    await svc.createSitting(staff(), { title: "Biology", date: planDay, startsAt: "09:00", endsAt: "11:00", hall: "Hall Z" });
    // Overlapping — refused, and the message NAMES the offender so it is actionable.
    await expect(
      svc.createSitting(staff(), { title: "Physics", date: planDay, startsAt: "10:00", endsAt: "12:00", hall: "Hall Z" }),
    ).rejects.toMatchObject({ status: 409 });
    // Case/whitespace differences are the SAME hall — this is what stopped
    // "Hall Z" / "hall z" quietly becoming two venues.
    await expect(
      svc.createSitting(staff(), { title: "Physics", date: planDay, startsAt: "10:00", endsAt: "12:00", hall: "  hall z " }),
    ).rejects.toMatchObject({ status: 409 });
    // Back-to-back is the normal school day and must NOT be flagged.
    const after = await svc.createSitting(staff(), { title: "Further Maths", date: planDay, startsAt: "11:00", endsAt: "13:00", hall: "Hall Z" });
    expect(after.id).toBeTruthy();
    // And an edit that would collide is refused too — without the exclude-self
    // fix, every save would collide with the row being saved.
    await expect(svc.updateSitting(staff(), after.id, { startsAt: "10:30" })).rejects.toMatchObject({ status: 409 });
    // A no-op-ish edit on itself still succeeds (proves self-exclusion works).
    const ok = await svc.updateSitting(staff(), after.id, { note: "bring calculators" });
    expect(ok.note).toBe("bring calculators");
  });

  it("refuses to roster an invigilator into two overlapping halls (409)", async () => {
    const a = await svc.createSitting(staff(), { title: "Govt", date: planDay, startsAt: "14:00", endsAt: "16:00", hall: "Hall P" });
    const b = await svc.createSitting(staff(), { title: "CRK", date: planDay, startsAt: "15:00", endsAt: "17:00", hall: "Hall Q" });
    await svc.assignInvigilator(staff(), a.id, TEACHER, false);
    // DIFFERENT halls, so a hall-only check would have missed this entirely.
    await expect(svc.assignInvigilator(staff(), b.id, TEACHER, false)).rejects.toMatchObject({ status: 409 });
    // A non-overlapping duty the same day is fine.
    const c = await svc.createSitting(staff(), { title: "Civic", date: planDay, startsAt: "17:00", endsAt: "18:00", hall: "Hall Q" });
    await expect(svc.assignInvigilator(staff(), c.id, TEACHER, false)).resolves.toMatchObject({ staffId: TEACHER });
  });

  it("a room from the registry supplies the hall label and its capacity", async () => {
    const roomId = randomUUID();
    await admin.query(`INSERT INTO room (id,"schoolId",name,capacity,"updatedAt") VALUES ($1,$2,'Assembly Hall',120,now())`, [roomId, SA]);
    const sit = await svc.createSitting(staff(), { title: "Economics", date: planDay, startsAt: "08:00", endsAt: "09:00", roomId });
    // Typing the hall name — and mistyping it — is no longer how a venue is chosen,
    // and the capacity is not retyped per sitting.
    expect(sit.hall).toBe("Assembly Hall");
    expect(sit.capacity).toBe(120);
    expect(sit.roomId).toBe(roomId);
  });

  it("bulk-seats a whole schedule INCLUDING paper sittings, and is safe to repeat", async () => {
    const sched = await svc.createSchedule(staff(), { title: "Mock Exams" });
    // A PAPER sitting: no CBT exam, so its class comes from classId — which is the
    // only reason this can be auto-seated at all.
    const paper = await svc.createSitting(staff(), {
      title: "Paper Maths",
      date: planDay,
      startsAt: "07:00",
      endsAt: "07:45",
      hall: "Hall R",
      classId,
      scheduleId: sched.id,
    });
    // The create response must echo the class NAME, not just the id — a row with
    // classId set but className null renders as "no class" in the console, which
    // reads as if setting it had failed.
    expect(paper.classId).toBe(classId);
    expect(paper.className).toBe("JSS3");

    const first = await svc.seatSchedule(staff(), sched.id);
    expect(first.seated).toBe(1);
    const seats = await admin.query(`SELECT "seatNo" FROM exam_seat WHERE "sittingId" = $1 ORDER BY "seatNo"`, [paper.id]);
    expect(seats.rows.map((r) => (r as { seatNo: number }).seatNo)).toEqual([1, 2]);

    // Pressing it again must NOT renumber seats students have already been told.
    const second = await svc.seatSchedule(staff(), sched.id);
    expect(second.seated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("the exam-day board groups by hall and flags an unstaffed one", async () => {
    const board = await svc.examDay(staff(), planDay);
    expect(board.date).toBe(planDay);
    expect(board.halls.length).toBeGreaterThan(0);
    // Sorted by start time — the order an exam officer walks the halls.
    const starts = board.halls.map((h) => h.startsAt);
    expect([...starts].sort()).toEqual(starts);
    // "Paper Maths" was seated but never rostered: the one omission that cannot be
    // repaired after the exam, so it must be surfaced.
    const unstaffed = board.halls.find((h) => h.title === "Paper Maths");
    expect(unstaffed).toMatchObject({ noInvigilator: true, noSeats: false });
    // And the one we did roster is not flagged.
    expect(board.halls.find((h) => h.title === "Govt")?.noInvigilator).toBe(false);
  });

  it("a RELEASED sitting is frozen against edits (409)", async () => {
    // Students may be mid-exam against a server clock derived from the exam, so
    // re-timing it underneath them is an incident, not a correction.
    const bankId = randomUUID();
    const examId = randomUUID();
    const subjId = randomUUID();
    await admin.query(`INSERT INTO subject (id,"schoolId",name,code,"updatedAt") VALUES ($1,$2,'Frozen Subj','FROZ',now())`, [subjId, SA]);
    await admin.query(`INSERT INTO cbt_question_bank (id,"schoolId",name,"subjectId","createdById","updatedAt") VALUES ($1,$2,'B2',$4,$3,now())`, [bankId, SA, ADMIN, subjId]);
    await admin.query(
      `INSERT INTO cbt_exam (id,"schoolId","bankId",title,"questionCount","durationMinutes","startAt","endAt",status,"releasedAt","createdById","updatedAt")
       VALUES ($1,$2,$3,'Live CBT',1,30,now(),now()+interval '1 day','PUBLISHED',now(),$4,now())`,
      [examId, SA, bankId, ADMIN],
    );
    const sit = await svc.createSitting(staff(), { title: "Live", date: planDay, startsAt: "19:00", endsAt: "20:00", hall: "Hall S" });
    await admin.query(`UPDATE exam_sitting SET "cbtExamId" = $1 WHERE id = $2`, [examId, sit.id]);
    await expect(svc.updateSitting(staff(), sit.id, { startsAt: "19:30" })).rejects.toMatchObject({ status: 409 });
  });

  it("the printable hall pack renders a real PDF listing the seated students", async () => {
    const sit = await svc.createSitting(staff(), { title: "Printable", date: planDay, startsAt: "06:00", endsAt: "06:45", hall: "Hall T", classId });
    await svc.seatClass(staff(), sit.id, classId);
    const { buffer, filename } = await svc.attendanceSheetPdf(staff(), sit.id);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF"); // a real PDF, not a stub
    expect(buffer.length).toBeGreaterThan(800);
    expect(filename).toMatch(/^attendance-Printable-\d{4}-\d{2}-\d{2}\.pdf$/);
    // Audited — it lists the names of minors sitting a specific exam.
    const log = await admin.query(`SELECT id FROM audit_log WHERE action = 'exam.attendance_sheet.print' AND "entityId" = $1`, [sit.id]);
    expect(log.rowCount).toBe(1);
  });

  it("filters sittings server-side rather than shipping the whole term", async () => {
    const oneDay = await svc.listSittings(staff(), { date: planDay });
    expect(oneDay.length).toBeGreaterThan(0);
    expect(oneDay.every((s) => s.date === planDay)).toBe(true);
    // A day with nothing on it returns nothing, not everything.
    expect(await svc.listSittings(staff(), { date: "2001-01-01" })).toHaveLength(0);
    // Text search covers title and subject.
    const found = await svc.listSittings(staff(), { q: "printab" });
    expect(found.map((s) => s.title)).toContain("Printable");
    // Hall filter is case-insensitive, like clash detection.
    expect((await svc.listSittings(staff(), { hall: "hall t" })).map((s) => s.title)).toContain("Printable");
  });

  it("rejects a sitting whose end time is not after its start", async () => {
    await expect(
      svc.createSitting(staff(), { title: "Backwards", date: planDay, startsAt: "11:00", endsAt: "09:00", hall: "Hall U" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
