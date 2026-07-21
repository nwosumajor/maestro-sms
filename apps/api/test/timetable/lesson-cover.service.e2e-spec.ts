// =============================================================================
// LessonCoverService — leave↔timetable cover computation (real DB)
// =============================================================================
// Proves: a lesson whose teacher is on APPROVED leave that weekday shows up as
// needing cover; a reliever can be assigned (and is notified); the absent
// teacher can't cover their own lesson; a double-booking (reliever already
// teaching that period) is refused; the reliever sees their own duty; removing
// clears it.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { LessonCoverService } from "../../src/timetable/lesson-cover.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

// A fixed FRIDAY inside the leave window (2026-08-07 is a Friday).
const FRIDAY = "2026-08-07";
const WINDOW_FROM = "2026-08-03"; // Mon
const WINDOW_TO = "2026-08-09"; // Sun

d("LessonCoverService (real Postgres)", () => {
  let admin: Pool;
  let svc: LessonCoverService;

  const SA = randomUUID();
  const ADMIN = randomUUID();
  const ABSENT = randomUUID(); // on leave Friday
  const RELIEVER = randomUUID(); // free Friday P1
  const BUSY = randomUUID(); // teaches P1 Friday (double-book)
  const classId = randomUUID();
  const busyClassId = randomUUID();
  const periodId = randomUUID();
  const entryId = randomUUID(); // ABSENT's Friday P1 lesson
  const busyEntryId = randomUUID(); // BUSY's Friday P1 lesson
  const leaveTypeId = randomUUID();

  const staff = (): Principal => ({ userId: ADMIN, schoolId: SA, roles: ["school_admin"], permissions: ["timetable.write"] });
  const reliever = (): Principal => ({ userId: RELIEVER, schoolId: SA, roles: ["teacher"], permissions: ["timetable.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'CV',$2,now())`, [SA, "cv-" + SA]);
    for (const [u, name] of [[ADMIN, "Admin"], [ABSENT, "Absent Teacher"], [RELIEVER, "Reliever"], [BUSY, "Busy Teacher"]] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@cv", name]);
    }
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'JSS1',now()),($3,$2,'JSS2',now())`, [classId, SA, busyClassId]);
    await admin.query(`INSERT INTO period (id,"schoolId",name,sequence,"startTime","endTime","updatedAt") VALUES ($1,$2,'P1',1,'08:00','08:45',now())`, [periodId, SA]);
    // ABSENT teaches JSS1 Maths on Friday P1.
    await admin.query(
      `INSERT INTO timetable_entry (id,"schoolId","classId","dayOfWeek","periodId",subject,"teacherId","updatedAt") VALUES ($1,$2,$3,'FRIDAY',$4,'Maths',$5,now())`,
      [entryId, SA, classId, periodId, ABSENT],
    );
    // BUSY also teaches Friday P1 (their own class) — makes them double-booked.
    await admin.query(
      `INSERT INTO timetable_entry (id,"schoolId","classId","dayOfWeek","periodId",subject,"teacherId","updatedAt") VALUES ($1,$2,$3,'FRIDAY',$4,'English',$5,now())`,
      [busyEntryId, SA, busyClassId, periodId, BUSY],
    );
    // ABSENT is on approved leave across the window.
    await admin.query(`INSERT INTO leave_type (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Annual',now())`, [leaveTypeId, SA]);
    await admin.query(
      `INSERT INTO leave_request (id,"schoolId","userId","leaveTypeId","startDate","endDate",days,status,"updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,5,'APPROVED',now())`,
      [randomUUID(), SA, ABSENT, leaveTypeId, WINDOW_FROM, WINDOW_TO],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new LessonCoverService(tenant, audit, notifications);
  });

  afterAll(async () => {
    for (const t of ["lesson_cover", "leave_request", "leave_type", "timetable_entry", "period", "class", "notification_delivery", "notification", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("flags the absent teacher's Friday lesson as needing cover", async () => {
    const list = await svc.lessonsNeedingCover(staff(), WINDOW_FROM, WINDOW_TO);
    const mine = list.filter((l) => l.timetableEntryId === entryId);
    expect(mine).toHaveLength(1); // only the ONE Friday in the window
    expect(mine[0]).toMatchObject({ date: FRIDAY, subject: "Maths", absentTeacherId: ABSENT, coveringTeacherId: null });
  });

  it("refuses to let the absent teacher cover their own lesson", async () => {
    await expect(
      svc.assignCover(staff(), { timetableEntryId: entryId, date: FRIDAY, coveringTeacherId: ABSENT }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a double-booked reliever (already teaching that period)", async () => {
    await expect(
      svc.assignCover(staff(), { timetableEntryId: entryId, date: FRIDAY, coveringTeacherId: BUSY }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("assigns a free reliever, notifies them, and shows in their duties + the list", async () => {
    const assigned = await svc.assignCover(staff(), { timetableEntryId: entryId, date: FRIDAY, coveringTeacherId: RELIEVER, note: "Cover P1 Maths" });
    expect(assigned).toMatchObject({ coveringTeacherId: RELIEVER, coveringTeacherName: "Reliever" });
    const notif = await admin.query(`SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Cover lesson assigned'`, [RELIEVER]);
    expect(notif.rowCount).toBe(1);
    const duties = await svc.myDuties(reliever(), WINDOW_FROM, WINDOW_TO);
    expect(duties).toHaveLength(1);
    expect(duties[0]).toMatchObject({ date: FRIDAY, subject: "Maths" });
    const list = await svc.lessonsNeedingCover(staff(), WINDOW_FROM, WINDOW_TO);
    expect(list.find((l) => l.timetableEntryId === entryId)?.coveringTeacherId).toBe(RELIEVER);
  });

  it("removing the cover clears it", async () => {
    const list = await svc.lessonsNeedingCover(staff(), WINDOW_FROM, WINDOW_TO);
    const coverId = list.find((l) => l.timetableEntryId === entryId)!.coverId!;
    await svc.removeCover(staff(), coverId);
    const after = await svc.myDuties(reliever(), WINDOW_FROM, WINDOW_TO);
    expect(after).toHaveLength(0);
  });
});
