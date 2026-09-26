// =============================================================================
// The days nobody recorded — counted, on the real database
// =============================================================================
// A register used to accept any subset of a class, a pupil left off simply had
// no mark, and every figure was computed over the marks that existed — so a day
// nobody recorded was invisible: in "times school opened" for the class, absent
// from the pupil's own figures, and nothing said so. Three things now make it
// visible and stop it recurring, and all three live in the DATABASE, where no
// unit double can check them:
//   - `enrollment.endedAt`, kept by a TRIGGER, so "was this pupil in the class
//     that day" has an exact answer (a leaver is not charged with their old
//     class's later registers; a joiner not with its earlier ones);
//   - the unrecorded-registers SQL (`attendance/roll.ts`), in total, by month
//     and by term, run as the APP ROLE under RLS;
//   - `attendance_session.takenAt`, so a register the scan desk started is not
//     "taken".
//
// THE SCENARIO — one class, four register days, six pupils:
//   D1 2026-03-02  D2 2026-03-03  D3 2026-04-01 (all TAKEN)
//   D4 2026-04-02  started by the SCAN DESK only (A checked in), never taken
//   A  on roll throughout, marked D1 D2 D3 (+ scan D4)     -> 0 unrecorded
//   B  on roll throughout, marked D1 only                  -> D2 D3 D4 = 3
//   L  LEFT on 2026-03-15, marked D1 D2                    -> 0 (D3/D4 after leaving)
//   J  JOINED on 2026-04-01, marked D3                     -> D4 = 1 (not D1/D2)
//   N  on roll throughout, NEVER marked                    -> 4, incl. a March
//      with no marks at all, which the month view used to drop entirely
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { AttendanceService } from "../../src/attendance/attendance.service";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { unrecordedByTerm, unrecordedCount } from "../../src/attendance/roll";
import type { Principal } from "../../src/integrity/integrity.foundation";

jest.setTimeout(60_000);

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("The days nobody recorded (real Postgres, app role)", () => {
  let admin: Pool;
  let app: Pool;
  let svc: AttendanceService;
  let tenantDb: PrismaTenantService;

  const SA = randomUUID();
  const ADMIN = randomUUID();
  const classId = randomUUID();
  const acad = randomUUID();
  const T1 = randomUUID();
  const T2 = randomUUID();
  const [A, B, L, J, N, R] = Array.from({ length: 6 }, () => randomUUID());
  const DAYS = { D1: "2026-03-02", D2: "2026-03-03", D3: "2026-04-01", D4: "2026-04-02" };

  const principal = (): Principal => ({
    userId: ADMIN,
    schoolId: SA,
    roles: ["school_admin"],
    permissions: ["attendance.read", "attendance.write", "attendance.amend.review"],
  });
  const asTenant = <T>(fn: (tx: Parameters<Parameters<PrismaTenantService["runAsTenant"]>[1]>[0]) => Promise<T>) =>
    tenantDb.runAsTenant({ schoolId: SA, userId: ADMIN }, fn);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    app = new Pool({ connectionString: APP_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'Unrec',$2,now())`, [SA, "unrec-" + SA]);
    for (const [id, name] of [[ADMIN, "Admin"], [A, "Ada"], [B, "Bola"], [L, "Leke"], [J, "Jide"], [N, "Nkem"], [R, "Remi"]]) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [
        id, SA, `${id}@unrec`, name,
      ]);
    }
    await admin.query(`INSERT INTO class (id,"schoolId",name,"supervisorId","updatedAt") VALUES ($1,$2,'JSS2B',$3,now())`, [classId, SA, ADMIN]);
    // Enrolments. L's end and J's start are the facts under test; R is the
    // trigger's own subject.
    const enrol = (student: string, enrolledAt: string) =>
      admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId",status,"enrolledAt") VALUES ($1,$2,$3,$4,'ACTIVE',$5)`, [
        randomUUID(), SA, classId, student, enrolledAt,
      ]);
    for (const s of [A, B, N, R]) await enrol(s, "2026-01-05T08:00:00Z");
    await enrol(J, "2026-04-01T07:00:00Z");
    // L is INSERTED already closed. An UPDATE of status would fire the trigger,
    // which stamps endedAt = now and would silently replace the date under test.
    await admin.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId",status,"enrolledAt","endedAt") VALUES ($1,$2,$3,$4,'TRANSFERRED','2026-01-05T08:00:00Z','2026-03-15T10:00:00Z')`,
      [randomUUID(), SA, classId, L],
    );

    await admin.query(`INSERT INTO academic_session (id,"schoolId",name,"startDate","endDate","updatedAt") VALUES ($1,$2,'2025/2026','2026-01-01','2026-12-31',now())`, [acad, SA]);
    await admin.query(
      `INSERT INTO term (id,"schoolId","sessionId",name,sequence,"startDate","endDate","isCurrent","updatedAt")
       VALUES ($1,$3,$4,'First',1,'2026-03-01','2026-03-31',false,now()), ($2,$3,$4,'Second',2,'2026-04-01','2026-12-31',true,now())`,
      [T1, T2, SA, acad],
    );

    // Registers. D1-D3 TAKEN; D4 only started by the scan desk (takenAt NULL).
    const sess: Record<string, string> = {};
    for (const [k, day] of Object.entries(DAYS)) {
      sess[k] = randomUUID();
      await admin.query(
        `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","takenAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [sess[k], SA, classId, day, ADMIN, k === "D4" ? null : new Date()],
      );
    }
    const mark = (k: keyof typeof DAYS, student: string, note: string | null = null) =>
      admin.query(
        `INSERT INTO attendance_record (id,"schoolId","sessionId","studentId",status,note,date,"updatedAt") VALUES ($1,$2,$3,$4,'PRESENT',$5,$6,now())`,
        [randomUUID(), SA, sess[k], student, note, DAYS[k]],
      );
    await mark("D1", A); await mark("D2", A); await mark("D3", A); await mark("D4", A, "scan check-in");
    await mark("D1", B);
    await mark("D1", L); await mark("D2", L);
    await mark("D3", J);

    tenantDb = new PrismaTenantService();
    const audit = new AuditLogService();
    const region = new SchoolRegionService(tenantDb);
    svc = new AttendanceService(tenantDb, audit, { notifyMany: jest.fn() } as never, {} as never, region, {
      onFinalized: jest.fn(),
    } as never);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM attendance_record WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM attendance_session WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM enrollment WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM term WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM academic_session WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM class WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM audit_log WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await app.end();
    await prisma.$disconnect();
  });

  it("the TRIGGER stamps endedAt when an enrolment closes, and a reopen starts a new span — as the app role", async () => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_school_id', $1, true), set_config('app.current_user_id', $2, true)`, [SA, ADMIN]);
      await c.query(`UPDATE enrollment SET status='WITHDRAWN' WHERE "studentId"=$1`, [R]);
      // Compared IN SQL. These are `timestamp without time zone` columns that
      // Prisma reads as UTC, and the `pg` driver reads as the machine's LOCAL
      // time — on a UTC+1 box a correct value read an hour out. What matters is
      // what is STORED: UTC, within a minute of now.
      const closed = (
        await c.query(
          `SELECT "endedAt" IS NOT NULL AS ended,
                  abs(extract(epoch FROM ("endedAt" - (now() AT TIME ZONE 'UTC')))) < 60 AS utc_now
             FROM enrollment WHERE "studentId"=$1`,
          [R],
        )
      ).rows[0];
      expect(closed).toEqual({ ended: true, utc_now: true });
      await c.query(`UPDATE enrollment SET status='ACTIVE' WHERE "studentId"=$1`, [R]);
      const reopened = (
        await c.query(
          `SELECT "endedAt" IS NULL AS open,
                  abs(extract(epoch FROM ("enrolledAt" - (now() AT TIME ZONE 'UTC')))) < 60 AS new_span
             FROM enrollment WHERE "studentId"=$1`,
          [R],
        )
      ).rows[0];
      expect(reopened).toEqual({ open: true, new_span: true });
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("the ROLL for a past day includes a pupil who has since left and excludes one who joined later", async () => {
    const roll = async (day: string) => (await svc.getRoll(principal(), classId, day)).students.map((s) => s.id).sort();
    expect(await roll(DAYS.D1)).toEqual([A, B, L, N, R].sort());
    expect(await roll(DAYS.D3)).toEqual([A, B, J, N, R].sort());
  });

  it("counts each pupil's unrecorded registers exactly — leaver and joiner charged nothing outside their span", async () => {
    const counts = await asTenant(async (tx) => ({
      A: await unrecordedCount(tx, A),
      B: await unrecordedCount(tx, B),
      L: await unrecordedCount(tx, L),
      J: await unrecordedCount(tx, J),
      N: await unrecordedCount(tx, N),
    }));
    expect(counts).toEqual({ A: 0, B: 3, L: 0, J: 1, N: 4 });
  });

  it("splits them by TERM in one query, and by the current term on the summary", async () => {
    const byTerm = await asTenant((tx) => unrecordedByTerm(tx, B));
    expect(byTerm.get(T1)).toBe(1);
    expect(byTerm.get(T2)).toBe(2);
    const summary = await svc.getStudentSummary(principal(), B);
    expect(summary).toMatchObject({ from: "2026-04-01", present: 0, total: 0, percent: null, unrecorded: 2 });
  });

  it("a month with NO marks at all still appears when registers were taken without the pupil", async () => {
    const compiled = await svc.compiledHistory(principal(), N, { grain: "month" });
    const march = compiled.buckets.find((b) => b.key === "2026-03");
    const april = compiled.buckets.find((b) => b.key === "2026-04");
    expect(march).toMatchObject({ total: 0, unrecorded: 2, percent: null });
    expect(april).toMatchObject({ total: 0, unrecorded: 2 });
    expect(compiled.lifetime.unrecorded).toBe(4);
  });

  it("the month page REACHES unrecorded days that come after the pupil's last mark", async () => {
    // B's last MARK is 2 March; their unrecorded registers run into April. The
    // page window used to be anchored on the last mark, so April — counted in
    // the lifetime line — was on no page at all. Found by driving a live pupil.
    const compiled = await svc.compiledHistory(principal(), B, { grain: "month" });
    expect(compiled.buckets.map((b) => b.key)).toEqual(["2026-04", "2026-03"]);
    expect(compiled.buckets[0]).toMatchObject({ total: 0, unrecorded: 2 });
    expect(compiled.total).toBe(2);
    expect(compiled.lifetime).toMatchObject({ total: 1, unrecorded: 3 });
  });

  it("a register the SCAN DESK started is not TAKEN on the board", async () => {
    const board = await svc.getRegisterStatus(principal(), DAYS.D4);
    const row = board.classes.find((c) => c.classId === classId);
    expect(row).toMatchObject({ taken: false, marked: 1 });
    const d3 = (await svc.getRegisterStatus(principal(), DAYS.D3)).classes.find((c) => c.classId === classId);
    expect(d3).toMatchObject({ taken: true });
  });

  it("a register must cover the day's roll: leaving a pupil off is refused, naming them; complete is saved and TAKEN", async () => {
    const day = "2026-09-01";
    const all = [A, B, J, N, R];
    await expect(
      svc.markAttendance(principal(), classId, {
        date: day,
        records: all.filter((s) => s !== N).map((studentId) => ({ studentId, status: "PRESENT" as const })),
      }),
    ).rejects.toThrow(/leaves out 1 pupil.*Nkem/);
    await svc.markAttendance(principal(), classId, {
      date: day,
      records: all.map((studentId) => ({ studentId, status: "PRESENT" as const })),
    });
    const taken = (await admin.query(`SELECT "takenAt" FROM attendance_session WHERE "classId"=$1 AND date=$2`, [classId, day])).rows[0];
    expect(taken.takenAt).not.toBeNull();
    // And a leaver may not be put on it.
    await expect(
      svc.markAttendance(principal(), classId, { date: day, records: [{ studentId: L, status: "PRESENT" }] }),
    ).rejects.toThrow(/not in this class on that date|not enrolled/);
  });
});
