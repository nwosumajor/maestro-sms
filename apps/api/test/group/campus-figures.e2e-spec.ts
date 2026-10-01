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
// A third campus (C, outside the group) carries a fixed two-week term so the
// REGISTER COVERAGE has one right answer — see its fixture — and invoices on
// each rung of the aging ladder. And the operator's group writes are driven
// for what they REFUSE: a pupil, a leaver, an outsider and a typo as director;
// a director whose school leaves the group.
//
// Runs as the privileged role, as the service does. Needs TEST_ADMIN_URL —
// `pnpm --filter @sms/api test:db` supplies it.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PrismaClient } from "@sms/db";
import { GROUP_PERIODS, schoolDateString, schoolMidnight } from "@sms/types";
import { campusFigures, loadCampuses, type Campus } from "../../src/group/campus-metrics";
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
  const SC = randomUUID(); // Lagos, a fixed term — not in the group
  const TEACHER_C = randomUUID();
  const LEAVER_A = randomUUID();
  const C_PUPIL_1 = randomUUID();
  const C_PUPIL_2 = randomUUID();
  const C1 = randomUUID();
  const C2 = randomUUID();
  const C3 = randomUUID();
  const SESSION_C = randomUUID();
  const DOOMED = randomUUID();
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

  const user = (id: string, school: string, role?: string, status = "ACTIVE") =>
    admin.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash",status,"updatedAt") VALUES ($1,$2,$3,$4,'x',$5,now())`,
      [id, school, `${id}@gf.test`, `GF ${id.slice(0, 8)}`, status],
    ).then(() =>
      role
        ? admin.query(
            `INSERT INTO user_role (id,"schoolId","userId","roleId") SELECT $1,$2,$3,id FROM role WHERE name = $4`,
            [randomUUID(), school, id, role],
          )
        : undefined,
    );
  /** A campus as the service builds one — region and terms from the database. */
  const campus = async (id: string): Promise<Campus> => {
    const rows = await client.school.findMany({ where: { id }, select: { id: true, country: true, timezone: true } });
    return (await loadCampuses(client, rows))[0];
  };
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
    await user(TEACHER_A, SA, "teacher");
    await user(TEACHER_B, SB, "teacher");
    await user(LEAVER_A, SA, "teacher", "EXITED");
    await user(PUPIL_B, SB);
    await user(PUPILS[0], SA, "student");
    for (const p of PUPILS.slice(1)) await user(p, SA);

    // --- attendance: one register at A, two days ago in Lagos ---------------
    const day = daysAgo(LAGOS, 2);
    await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'GF 1',now())`, [CLASS_A, SA]);
    await admin.query(
      // TAKEN (`takenAt` set): only the register's own save makes a register taken.
      `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","takenAt","updatedAt")
       VALUES ($1,$2,$3,$4::date,$5,$4::timestamp + interval '8 hours',now())`,
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
      // Only campus A's plan includes the Group Console in this fixture.
      { isEnabled: async (schoolId: string) => schoolId === SA } as never,
    );

    // --- campus C: a fixed term, so register coverage has ONE right answer ----
    //
    // Current term Mon 1 – Fri 12 June 2026, Nigeria (Mon–Fri), a holiday on
    // Fri 12 June: 9 school days.
    //   C1 — a pupil on roll throughout: 9 registers due. Taken on 8; on 5 June
    //        only a gate scan opened the register (no takenAt), which is NOT a
    //        register taken. Also taken on Sat 6 June, which was not due.
    //   C2 — a pupil who joined on Mon 8 June: due 8–11 June (the 12th is the
    //        holiday) = 4. Taken on all 4.
    //   C3 — nobody on roll: nothing due.
    // Expected 13, covered 12 → 92%. Taken (anything with takenAt) 13.
    // An earlier dated term, 18–29 May, holds the comparison window
    // (20–31 May): C1 due on 8 weekdays, taken on one → 13%.
    await admin.query(
      `INSERT INTO school (id,name,slug,country,"updatedAt") VALUES ($1,'GF Fixed Term',$2,'NG',now())`,
      [SC, `gf-c-${SC}`],
    );
    await user(TEACHER_C, SC, "teacher");
    await user(C_PUPIL_1, SC, "student");
    await user(C_PUPIL_2, SC, "student");
    const SESSION_YEAR = randomUUID();
    await admin.query(
      `INSERT INTO academic_session (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'2025/2026',now())`,
      [SESSION_YEAR, SC],
    );
    await admin.query(
      `INSERT INTO term (id,"schoolId","sessionId",name,sequence,"isCurrent","startDate","endDate","updatedAt")
       VALUES ($1,$2,$3,'Summer',3,true,'2026-06-01','2026-06-12',now()),
              ($4,$2,$3,'Late spring',2,false,'2026-05-18','2026-05-29',now())`,
      [randomUUID(), SC, SESSION_YEAR, randomUUID()],
    );
    await admin.query(
      `INSERT INTO school_holiday (id,"schoolId",name,"startDate","endDate","createdById","updatedAt")
       VALUES ($1,$2,'Democracy Day','2026-06-12','2026-06-12',$3,now())`,
      [randomUUID(), SC, TEACHER_C],
    );
    for (const [id, name] of [[C1, "C1"], [C2, "C2"], [C3, "C3"]]) {
      await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,$3,now())`, [id, SC, `GF ${name}`]);
    }
    await admin.query(
      `INSERT INTO enrollment (id,"schoolId","classId","studentId","enrolledAt") VALUES ($1,$2,$3,$4,'2026-05-01 08:00'),($5,$2,$6,$7,'2026-06-08 08:00')`,
      [randomUUID(), SC, C1, C_PUPIL_1, randomUUID(), C2, C_PUPIL_2],
    );
    const register = (classId: string, day: string, taken: boolean, id: string = randomUUID()) =>
      admin.query(
        `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","takenAt","updatedAt")
         VALUES ($1,$2,$3,$4::date,$5,$6::timestamp,now())`,
        [id, SC, classId, day, TEACHER_C, taken ? `${day} 08:30` : null],
      );
    for (const day of ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"]) {
      await register(C1, day, true);
    }
    await register(C1, "2026-06-05", false, SESSION_C); // a gate scan opened it; nobody took it
    await register(C1, "2026-06-06", true); // a Saturday: taken, but not due
    for (const day of ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"]) await register(C2, day, true);
    await register(C1, "2026-05-25", true); // the comparison window

    // Money at C on every rung of the ladder, due relative to LAGOS's today.
    const cInvoice = async (total: number, dueDaysAgo: number, paid = 0) => {
      const id = randomUUID();
      const due = daysAgo(LAGOS, dueDaysAgo);
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,"dueDate","createdById","totalMinor",status,currency,"updatedAt")
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8::"InvoiceStatus",'NGN',now())`,
        [id, SC, C_PUPIL_1, `GFC-${id.slice(0, 8)}`, due, TEACHER_C, total, paid > 0 ? "PARTIALLY_PAID" : "ISSUED"],
      );
      if (paid > 0) await payment(SC, id, TEACHER_C, paid, "PAYMENT", new Date(now.getTime() - 3_600_000));
    };
    await cInvoice(1_000, 0); // due today: not yet late
    await cInvoice(2_000, 10); // 1–30
    await cInvoice(3_000, 45); // 31–60
    await cInvoice(4_000, 90, 500); // 60+, part paid
    // An invoice marked PAID that is NOT paid — found on a live database, with no
    // audit entry for the change. The finance report counts its balance, so the
    // console must too. GHS, so it sits apart from the NGN ladder above.
    const lying = randomUUID();
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"dueDate","createdById","totalMinor",status,currency,"updatedAt")
       VALUES ($1,$2,$3,$4,$5::date,$6,1000,'PAID','GHS',now())`,
      [lying, SC, C_PUPIL_1, `GFC-${lying.slice(0, 8)}`, daysAgo(LAGOS, 0), TEACHER_C],
    );

    // A second group, only so it can be deleted.
    await admin.query(`INSERT INTO school_group (id,name,"updatedAt") VALUES ($1,'GF Doomed',now())`, [DOOMED]);
    await admin.query(`INSERT INTO school_group_member (id,"groupId","schoolId") VALUES ($1,$2,$3)`, [randomUUID(), DOOMED, SA]);

    // A fixture whose rows silently failed to insert would make every
    // assertion below vacuous.
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM payment WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    expect(rows[0].n).toBe(7);
    const sessions = await admin.query(`SELECT count(*)::int AS n FROM attendance_session WHERE "schoolId" = $1`, [SC]);
    expect(sessions.rows[0].n).toBe(15);
  });

  afterAll(async () => {
    const ids = [[SA, SB, SC]];
    await admin.query(`DELETE FROM school_group_director WHERE "groupId" = ANY($1)`, [[GROUP, DOOMED]]);
    await admin.query(`DELETE FROM school_group_member WHERE "groupId" = ANY($1)`, [[GROUP, DOOMED]]);
    await admin.query(`DELETE FROM school_group WHERE id = ANY($1)`, [[GROUP, DOOMED]]);
    await admin.query(`DELETE FROM attendance_record WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM attendance_session WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM payment WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM invoice WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM enrollment WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM class WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school_holiday WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM term WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM academic_session WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM user_role WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school_subscription WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, ids);
    await client.$disconnect();
    await admin.end();
  });

  it("rates attendance by the platform's rule: LATE attends, EXCUSED does not", async () => {
    const fig = (await campusFigures(client, [await campus(SA)], "term", now)).get(SA)!;
    expect(fig.registersTaken).toBe(1);
    expect(fig.attendancePct).toBe(80);
  });

  it("collects NET of refunds, counts credit and scholarship, and never a pending payment", async () => {
    const fig = (await campusFigures(client, [await campus(SA)], "term", now)).get(SA)!;
    expect(fig.money).toEqual([expect.objectContaining({ currency: "NGN", collectedMinor: 135_000, outstandingMinor: 75_000 })]);
  });

  it("cuts a Toronto month at Toronto's midnight, not the server's", async () => {
    const month = (await campusFigures(client, [await campus(SB)], "month", now)).get(SB)!;
    const term = (await campusFigures(client, [await campus(SB)], "term", now)).get(SB)!;
    // The 5,000 paid two hours before Toronto's month began is last month THERE.
    expect(month.money).toEqual([expect.objectContaining({ currency: "USD", collectedMinor: 7_000, outstandingMinor: 18_000 })]);
    // No current term at B, so "term" is the last 90 days — and says so.
    expect(term.window.basis).toBe("NO_TERM_LAST_90_DAYS");
    expect(term.money).toEqual([expect.objectContaining({ currency: "USD", collectedMinor: 12_000, outstandingMinor: 18_000 })]);
  });

  it("answers for several campuses at once exactly as it does for each alone", async () => {
    const both = await campusFigures(client, [await campus(SA), await campus(SB)], "month", now);
    const a = await campusFigures(client, [await campus(SA)], "month", now);
    const b = await campusFigures(client, [await campus(SB)], "month", now);
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

  // --- register coverage, aging and comparison (campus C) --------------------

  it("measures registers against the ones DUE: school days, in term, not a holiday, a class with pupils", async () => {
    const fig = (await campusFigures(client, [await campus(SC)], "term", now)).get(SC)!;
    expect(fig.window).toEqual({ fromDay: "2026-06-01", toDay: "2026-06-12", basis: "TERM" });
    expect({ taken: fig.registersTaken, expected: fig.registersExpected, covered: fig.registersCovered, pct: fig.registerCoveragePct }).toEqual({
      // 13 taken, including the Saturday; the scan-opened register on 5 June is not one.
      taken: 13,
      // C1 9 school days (12 June a holiday) + C2 4 days since joining + C3 none.
      expected: 13,
      // Every due register but 5 June.
      covered: 12,
      pct: 92,
    });
  });

  it("compares with the same span before it, counting what was due THEN", async () => {
    const fig = (await campusFigures(client, [await campus(SC)], "term", now)).get(SC)!;
    expect(fig.previous.window).toMatchObject({ fromDay: "2026-05-20", toDay: "2026-05-31" });
    // 8 weekdays of the earlier term inside 20–31 May, one register taken.
    expect(fig.previous.registerCoveragePct).toBe(13);
  });

  it("ages what is owed on the finance report's ladder, from the campus's own today", async () => {
    const fig = (await campusFigures(client, [await campus(SC)], "month", now)).get(SC)!;
    expect(fig.money).toEqual([
      {
        currency: "NGN",
        collectedMinor: 500,
        outstandingMinor: 9_500,
        overdueMinor: 8_500,
        aging: { currentMinor: 1_000, d1_30Minor: 2_000, d31_60Minor: 3_000, d60plusMinor: 3_500 },
      },
      // The invoice marked PAID with nothing paid: owed, as the finance report says.
      {
        currency: "GHS",
        collectedMinor: 0,
        outstandingMinor: 1_000,
        overdueMinor: 0,
        aging: { currentMinor: 1_000, d1_30Minor: 0, d31_60Minor: 0, d60plusMinor: 0 },
      },
    ].sort((a, b) => a.currency.localeCompare(b.currency)));
  });

  it("reports NULL coverage, not zero, where no dated term says which days were due", async () => {
    const fig = (await campusFigures(client, [await campus(SA)], "term", now)).get(SA)!;
    expect(fig.registersExpected).toBeNull();
    expect(fig.registerCoveragePct).toBeNull();
  });

  // --- the operator's group writes ---------------------------------------------

  const operator: Principal = { schoolId: SA, userId: TEACHER_A, roles: ["super_admin"], permissions: [] };

  it("names every director it did NOT appoint, and why", async () => {
    const res = await svc.setDirectors(operator, GROUP, [
      `${TEACHER_A}@gf.test`, // staff at a member school: appointed
      `${PUPILS[0]}@gf.test`, // a pupil
      `${LEAVER_A}@gf.test`, // a leaver
      `${TEACHER_C}@gf.test`, // staff, but C is not in the group
      "nobody@gf.test", // a typo
    ]);
    expect(res.applied).toBe(1);
    const why = Object.fromEntries(res.notApplied.map((n) => [n.value, n.reason]));
    expect(why[`${PUPILS[0]}@gf.test`]).toMatch(/pupil or a parent/);
    expect(why[`${LEAVER_A}@gf.test`]).toMatch(/no longer active/);
    expect(why[`${TEACHER_C}@gf.test`]).toMatch(/not a member of the group/);
    expect(why["nobody@gf.test"]).toMatch(/No account/);
    const { rows } = await admin.query(`SELECT "userId" FROM school_group_director WHERE "groupId" = $1`, [GROUP]);
    expect(rows.map((r) => r.userId)).toEqual([TEACHER_A]);
  });

  it("tells the operator which directors cannot open the console — their school lacks the module", async () => {
    await svc.setDirectors(operator, GROUP, [`${TEACHER_A}@gf.test`, `${TEACHER_B}@gf.test`]);
    const g = (await svc.listGroups()).find((x) => x.id === GROUP)!;
    const by = Object.fromEntries(g.directors.map((d) => [d.userId, d.consoleEnabled]));
    expect(by).toEqual({ [TEACHER_A]: true, [TEACHER_B]: false });
  });

  it("offers as candidates only active staff at member schools, with a total", async () => {
    const all = await svc.directorCandidates(GROUP, "");
    expect(all.rows.map((r) => r.userId).sort()).toEqual([TEACHER_A, TEACHER_B].sort());
    expect(all.total).toBe(2);
    const one = await svc.directorCandidates(GROUP, TEACHER_B.slice(0, 8));
    expect(one.rows.map((r) => r.userId)).toEqual([TEACHER_B]);
    expect(one.total).toBe(1);
  });

  it("removes a director whose school LEAVES the group, and says so", async () => {
    await svc.setDirectors(operator, GROUP, [`${TEACHER_A}@gf.test`, `${TEACHER_B}@gf.test`]);
    const bogus = randomUUID();
    const res = await svc.setMembers(operator, GROUP, [SA, bogus]);
    expect(res.applied).toBe(1);
    expect(res.notApplied.map((n) => n.value)).toEqual([bogus]);
    expect(res.removedDirectors.map((d) => d.email)).toEqual([`${TEACHER_B}@gf.test`]);
    const { rows } = await admin.query(`SELECT "userId" FROM school_group_director WHERE "groupId" = $1`, [GROUP]);
    expect(rows.map((r) => r.userId)).toEqual([TEACHER_A]);
    // Put B back for anything after this.
    await svc.setMembers(operator, GROUP, [SA, SB]);
  });

  it("renames and deletes a group; deleting takes its members and directors with it", async () => {
    await svc.renameGroup(operator, DOOMED, "GF Doomed (renamed)");
    expect((await svc.listGroups()).find((g) => g.id === DOOMED)?.name).toBe("GF Doomed (renamed)");
    await svc.deleteGroup(operator, DOOMED);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM school_group_member WHERE "groupId" = $1`, [DOOMED]);
    expect(rows[0].n).toBe(0);
    expect((await svc.listGroups()).some((g) => g.id === DOOMED)).toBe(false);
  });
});
