// =============================================================================
// MeetingService — parent-teacher slots + bookings (real DB)
// =============================================================================
// Proves: a teacher opens a slot; a parent books it for their OWN child (and
// cannot book for someone else's); a single-capacity slot rejects a second
// booking; the teacher is notified; either party can cancel; a full slot drops
// out of the open list.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { MeetingService } from "../../src/meeting/meeting.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("MeetingService (real Postgres)", () => {
  let admin: Pool;
  let svc: MeetingService;

  const SA = randomUUID();
  const TEACHER = randomUUID();
  const PARENT = randomUUID();
  const OTHER_PARENT = randomUUID();
  const CHILD = randomUUID();
  const OTHER_CHILD = randomUUID();

  const teacher = (): Principal => ({ userId: TEACHER, schoolId: SA, roles: ["teacher"], permissions: ["meeting.host"] });
  const parent = (): Principal => ({ userId: PARENT, schoolId: SA, roles: ["parent"], permissions: ["meeting.book"] });
  const otherParent = (): Principal => ({ userId: OTHER_PARENT, schoolId: SA, roles: ["parent"], permissions: ["meeting.book"] });

  const soon = new Date(Date.now() + 3 * 86_400_000);
  const later = new Date(soon.getTime() + 30 * 60_000);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'MT',$2,now())`, [SA, "mt-" + SA]);
    for (const [u, name] of [[TEACHER, "Teacher"], [PARENT, "Parent"], [OTHER_PARENT, "Other Parent"], [CHILD, "Child"], [OTHER_CHILD, "Other Child"]] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@mt", name]);
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, PARENT, CHILD]);
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [randomUUID(), SA, OTHER_PARENT, OTHER_CHILD]);

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new MeetingService(tenant, audit, notifications);
  });

  afterAll(async () => {
    for (const t of ["meeting_booking", "meeting_slot", "parent_child", "notification_delivery", "notification", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  let slotId = "";

  it("a teacher opens a slot; it shows in the open list", async () => {
    const slot = await svc.createSlot(teacher(), { startsAt: soon.toISOString(), endsAt: later.toISOString(), capacity: 1 });
    slotId = slot.id;
    expect(slot.teacherId).toBe(TEACHER);
    const open = await svc.openSlots(parent());
    expect(open.some((s) => s.id === slotId)).toBe(true);
  });

  it("a parent cannot book for someone else's child", async () => {
    await expect(svc.book(parent(), slotId, OTHER_CHILD)).rejects.toMatchObject({ status: 403 });
  });

  it("a parent books for their own child; the teacher is notified", async () => {
    const b = await svc.book(parent(), slotId, CHILD, "Discuss progress");
    expect(b).toMatchObject({ studentId: CHILD, status: "BOOKED" });
    const notif = await admin.query(`SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Parent meeting booked'`, [TEACHER]);
    expect(notif.rowCount).toBe(1);
  });

  it("a full single-capacity slot rejects a second booking and drops from the open list", async () => {
    await expect(svc.book(otherParent(), slotId, OTHER_CHILD)).rejects.toMatchObject({ status: 409 });
    const open = await svc.openSlots(otherParent());
    expect(open.some((s) => s.id === slotId)).toBe(false); // full
  });

  it("the parent sees their booking and can cancel it, freeing the slot", async () => {
    const mine = await svc.myBookings(parent());
    expect(mine).toHaveLength(1);
    await svc.cancelBooking(parent(), mine[0].id);
    expect(await svc.myBookings(parent())).toHaveLength(0);
    const open = await svc.openSlots(otherParent());
    expect(open.some((s) => s.id === slotId)).toBe(true); // free again
  });
});
