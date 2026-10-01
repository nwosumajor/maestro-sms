// =============================================================================
// The group console's figures, against a real Postgres
// =============================================================================
// Every figure the console shows comes from ONE `campusFigures`. Its unit
// double cannot see a date window, a refund's sign or a zone, so this drives
// the real SQL over rows chosen so that each defect it replaced gives a
// DIFFERENT number from the right one:
//
//   attendance   7 present, 1 late, 1 excused, 1 absent of 10 → 80%.
//                Counting EXCUSED as attending (the old overview) gives 90.
//   collected    payments 60,000 + 70,000, a refund of 10,000, a scholarship
//                of 15,000 → 135,000 net. PAYMENT-kind only gave 130,000.
//                A PENDING_APPROVAL payment never counts.
//   owed now     an open invoice 100,000 with 50,000 net paid, and one of
//                40,000 with a 15,000 scholarship → 50,000 + 25,000 = 75,000.
//                Subtracting PAYMENT-kind money only gave 80,000.
//   the day      a Toronto campus's month starts at 04:00Z, not 00:00Z: a
//                payment at 02:00Z on the 1st is LAST month there. Cutting at
//                the server's midnight counted it.
//
// Then the overview and the campus page are asked about the same campus for
// every period and must agree on every figure and flag — through the real
// queries, which is the agreement the unit double could only assume.
//
// Runs as the privileged role, as the service does. Needs TEST_ADMIN_URL —
// `pnpm --filter @sms/api test:db` supplies it.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PrismaClient } from "@sms/db";
import { GROUP_PERIODS, schoolDateString, schoolMidnight } from "@sms/types";
import { campusFigures } from "../../src/group/campus-metrics";
import { GroupService } from "../../src/group/group.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = ADMIN_URL ? describe : describe.skip;

const LAGOS = "Africa/Lagos";
const TORONTO = "America/Toronto";

/** `YYYY-MM-DD` at the school, `n` days ago. */
function daysAgo(tz: string, n: number): string {
  const t = new Date(`${schoolDateString(tz)}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

d("group console figures (real Postgres)", () => {
  let admin: Pool;
  let client: PrismaClient;

  const SA = randomUUID(); // Lagos, NGN
  const SB = randomUUID(); // Toronto, USD
  const GROUP = randomUUID();
  const TEACHER_A = randomUUID();
  const TEACHER_B = randomUUID();
  const PUPILS = Array.from({ length: 10 }, () => randomUUID());
  const PUPIL_B = randomUUID();
  const CLASS_A = randomUUID();
  const SESSION_A = randomUUID();
  const INV1 = randomUUID();
  const INV2 = randomUUID();
  const INV3 = randomUUID();
  const INV_B = randomUUID();
  const now = new Date();

  /** Toronto's month starts at local midnight — 04:00Z or 05:00Z, never 00:00Z. */
  const torontoMonthStart = schoolMidnight(`${schoolDateString(TORONTO, now).slice(0, 7)}-01`, TORONTO);

  const director: Principal = { schoolId: SA, userId: TEACHER_A, roles: ["principal"], permissions: [] };
  let svc: GroupService;

  const user = (id: string, school: string) =>
    admin.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'GF','x',now())`,
      [id, school, `${id}@gf.test`],
    );
  const invoice = (id: string, school: string, student: string, by: string, total: number, status: string, currency: string) =>
    admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"dueDate","createdById","totalMinor",status,currency,"updatedAt")
       VALUES ($1,$2,$3,$4,now()::date,$5,$6,$7::"InvoiceStatus",$8,now())`,
      [id, school, student, `GF-${id.slice(0, 8)}`, by, total, status, currency],
    );
  const payment = (school: string, inv: string, by: string, amount: number, kind: string, paidAt: Date, status = "POSTED") =>
    admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById",kind,status,"paidAt")
       VALUES ($1,$2,$3,$4,'CASH',$5,$6::"PaymentKind",$7::"PaymentStatus",$8::timestamp)`,
      // Written as UTC wall-clock text: the column has no zone, and a Date
      // parameter would be re-read through this session's.
      [randomUUID(), school, inv, amount, by, kind, status, paidAt.toISOString().slice(0, 23)],
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    client = new PrismaClient({ datasourceUrl: ADMIN_URL });

    await admin.query(
      `INSERT INTO school (id,name,slug,country,"updatedAt") VALUES ($1,'GF Lagos',$2,'NG',now())`,
      [SA, `gf-a-${SA}`],
    );
    await admin.query(
      `INSERT INTO school (id,name,slug,timezone,currency,"updatedAt") VALUES ($1,'GF Toronto',$2,$3,'USD',now())`,
      [SB, `gf-b-${SB}`, TORONTO],
    );
    for (const s of [SA, SB]) {
      await admin.query(
        `INSERT INTO school_subscription (id,"schoolId",plan,status,"updatedAt") VALUES ($1,$2,'PREMIUM','ACTIVE',now())`,
        [randomUUID(), s],
      );
    }
    await user(TEACHER_A, SA);
    await user(TEACHER_B, SB);
    await user(PUPIL_B, SB);
    for (const p of PUPILS) await user(p, SA);

    // --- attendance: one register at A, two days ago in Lagos ---------------
    const day = daysAgo(LAGOS, 2);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'GF 1',now())`, [CLASS_A, SA]);
    await admin.query(
      `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","updatedAt") VALUES ($1,$2,$3,$4::date,$5,now())`,
      [SESSION_A, SA, CLASS_A, day, TEACHER_A],
    );
    const statuses = ["PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT", "LATE", "EXCUSED", "ABSENT"];
    for (let i = 0; i < PUPILS.length; i++) {
      await admin.query(
        `INSERT INTO attendance_record ("schoolId","sessionId","studentId",status,date,"updatedAt")
         VALUES ($1,$2,$3,$4::"AttendanceStatus",$5::date,now())`,
        [SA, SESSION_A, PUPILS[i], statuses[i], day],
      );
    }

    // --- money at A (NGN) ---------------------------------------------------
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    await invoice(INV1, SA, PUPILS[0], TEACHER_A, 100_000, "PARTIALLY_PAID", "NGN");
    await invoice(INV2, SA, PUPILS[1], TEACHER_A, 70_000, "PAID", "NGN");
    await invoice(INV3, SA, PUPILS[2], TEACHER_A, 40_000, "PARTIALLY_PAID", "NGN");
    await payment(SA, INV1, TEACHER_A, 60_000, "PAYMENT", hoursAgo(5 * 24));
    await payment(SA, INV1, TEACHER_A, 10_000, "REFUND", hoursAgo(24));
    await payment(SA, INV1, TEACHER_A, 99_999, "PAYMENT", hoursAgo(2), "PENDING_APPROVAL");
    await payment(SA, INV2, TEACHER_A, 70_000, "PAYMENT", hoursAgo(3 * 24));
    await payment(SA, INV3, TEACHER_A, 15_000, "SCHOLARSHIP", hoursAgo(4 * 24));

    // --- money at B (USD): one payment either side of TORONTO's midnight ----
    await invoice(INV_B, SB, PUPIL_B, TEACHER_B, 30_000, "PARTIALLY_PAID", "USD");
    await payment(SB, INV_B, TEACHER_B, 5_000, "PAYMENT", new Date(torontoMonthStart.getTime() - 2 * 3_600_000));
    await payment(SB, INV_B, TEACHER_B, 7_000, "PAYMENT", new Date(Math.max(torontoMonthStart.getTime(), now.getTime() - 60_000)));

    // --- the group ------------------------------------------------------------
    await admin.query(`INSERT INTO school_group (id,name,"updatedAt") VALUES ($1,'GF Group',now())`, [GROUP]);
    for (const s of [SA, SB]) {
      await admin.query(`INSERT INTO school_group_member (id,"groupId","schoolId") VALUES ($1,$2,$3)`, [randomUUID(), GROUP, s]);
    }
    await admin.query(`INSERT INTO school_group_director (id,"groupId","userId") VALUES ($1,$2,$3)`, [randomUUID(), GROUP, TEACHER_A]);

    svc = new GroupService(
      { runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never,
      { record: jest.fn() } as never,
      { client } as never,
    );

    // A fixture whose rows silently failed to insert would make every
    // assertion below vacuous.
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM payment WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    expect(rows[0].n).toBe(7);
  });

  afterAll(async () => {
    const ids = [[SA, SB]];
    await admin.query(`DELETE FROM school_group_director WHERE "groupId" = $1`, [GROUP]);
    await admin.query(`DELETE FROM school_group_member WHERE "groupId" = $1`, [GROUP]);
    await admin.query(`DELETE FROM school_group WHERE id = $1`, [GROUP]);
    await admin.query(`DELETE FROM attendance_record WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM attendance_session WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM payment WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM invoice WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM class WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school_subscription WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, ids);
    await client.$disconnect();
    await admin.end();
  });

  it("rates attendance by the platform's rule: LATE attends, EXCUSED does not", async () => {
    const fig = (await campusFigures(client, [{ id: SA, timezone: LAGOS }], "term", now)).get(SA)!;
    expect(fig.registersTaken).toBe(1);
    expect(fig.attendancePct).toBe(80);
  });

  it("collects NET of refunds, counts credit and scholarship, and never a pending payment", async () => {
    const fig = (await campusFigures(client, [{ id: SA, timezone: LAGOS }], "term", now)).get(SA)!;
    expect(fig.money).toEqual([{ currency: "NGN", collectedMinor: 135_000, outstandingMinor: 75_000 }]);
  });

  it("cuts a Toronto month at Toronto's midnight, not the server's", async () => {
    const month = (await campusFigures(client, [{ id: SB, timezone: TORONTO }], "month", now)).get(SB)!;
    const term = (await campusFigures(client, [{ id: SB, timezone: TORONTO }], "term", now)).get(SB)!;
    // The 5,000 paid two hours before Toronto's month began is last month THERE.
    expect(month.money).toEqual([{ currency: "USD", collectedMinor: 7_000, outstandingMinor: 18_000 }]);
    expect(term.money).toEqual([{ currency: "USD", collectedMinor: 12_000, outstandingMinor: 18_000 }]);
  });

  it("answers for several campuses at once exactly as it does for each alone", async () => {
    const both = await campusFigures(client, [{ id: SA, timezone: LAGOS }, { id: SB, timezone: TORONTO }], "month", now);
    const a = await campusFigures(client, [{ id: SA, timezone: LAGOS }], "month", now);
    const b = await campusFigures(client, [{ id: SB, timezone: TORONTO }], "month", now);
    expect(both.get(SA)).toEqual(a.get(SA));
    expect(both.get(SB)).toEqual(b.get(SB));
  });

  for (const { key } of GROUP_PERIODS) {
    it(`gives the campus page the overview row's figures over "${key}", through the real queries`, async () => {
      const overview = await svc.overview(director, { period: key });
      expect(overview.schools).toHaveLength(2);
      for (const row of overview.schools) {
        const detail = await svc.schoolDetail(director, row.schoolId, { period: key });
        expect(detail.period.key).toBe(key);
        expect({
          attendancePct: detail.attendancePct,
          registersTaken: detail.registersTaken,
          money: detail.money,
          flags: detail.flags,
        }).toEqual({
          attendancePct: row.attendancePct,
          registersTaken: row.registersTaken,
          money: row.money,
          flags: row.flags,
        });
      }
    });
  }

  it("draws the campus trend in the campus's own months and currency", async () => {
    const detail = await svc.schoolDetail(director, SB, { period: "month" });
    expect(detail.trendCurrency).toBe("USD");
    const thisMonth = schoolDateString(TORONTO, now).slice(0, 7);
    expect(detail.trend.at(-1)).toMatchObject({ month: thisMonth, collectedMinor: 7_000 });
    // The 5,000 lands in the PREVIOUS Toronto month, still inside six months.
    expect(detail.trend.at(-2)!.collectedMinor).toBe(5_000);
  });
});
