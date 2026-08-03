// =============================================================================
// Five years of attendance stays READABLE (real DB)
// =============================================================================
// The question this answers is a literal one: can a principal open the attendance
// recorded five years ago?
//
// Before this, no. A pupil's history was `take: 200` with no paging and no total —
// roughly one school year — so a pupil in their fifth year had four years of
// records that no page could reach, and nothing on screen said they existed. The
// class board accepted a date window but the UI never sent one, so it only ever
// showed the current term.
//
// This seeds FIVE YEARS of real registers (15 terms) and proves three things:
//   1. every year is reachable by paging, and the stated total is the true one;
//   2. a term from five years ago can be opened by name on the class board;
//   3. the rollup that serves it agrees EXACTLY with scanning the registers —
//      a precomputed figure that quietly disagreed would be worse than a slow page,
//      because attendance figures end up in board minutes and government returns.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { AttendanceService } from "../../src/attendance/attendance.service";
import { AttendanceRollupService } from "../../src/attendance/attendance-rollup.service";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

// This suite SEEDS FIVE YEARS of attendance before it asserts anything, then runs
// alongside 158 others competing for the same Postgres. Jest's 5s default is a
// number nobody chose for this: it passes in ~0.4s alone and times out under
// load, which reads as a flaky failure and trains people to re-run the suite
// rather than read it. The work is real; the budget was not.
jest.setTimeout(60_000);

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

const YEARS = 5;
const TERMS_PER_YEAR = 3;
const DAYS_PER_TERM = 60; // ~a term of school days
const PUPILS = 4;

d("Five years of attendance history (real Postgres)", () => {
  let admin: Pool;
  let svc: AttendanceService;
  let rollup: AttendanceRollupService;

  const SA = randomUUID();
  const HEAD = randomUUID();
  const classId = randomUUID();
  const sessionAcademicId = randomUUID();
  const pupils = Array.from({ length: PUPILS }, () => randomUUID());
  const termIds: string[] = [];
  const termNames: string[] = [];
  let oldestTermId = "";

  const head = (): Principal => ({
    userId: HEAD,
    schoolId: SA,
    roles: ["principal"],
    permissions: ["attendance.read"],
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'FiveYr',$2,now())`, [SA, "fiveyr-" + SA]);
    await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'Head','x',now())`, [
      HEAD,
      SA,
      HEAD + "@fiveyr",
    ]);
    for (const [i, u] of pupils.entries()) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [
        u,
        SA,
        u + "@fiveyr",
        `Pupil ${i + 1}`,
      ]);
    }
    await admin.query(`INSERT INTO class (id,"schoolId",name,"supervisorId","updatedAt") VALUES ($1,$2,'JSS1A',$3,now())`, [classId, SA, HEAD]);
    for (const u of pupils) {
      await admin.query(`INSERT INTO enrollment (id,"schoolId","classId","studentId",status) VALUES ($1,$2,$3,$4,'ACTIVE')`, [
        randomUUID(),
        SA,
        classId,
        u,
      ]);
    }
    await admin.query(`INSERT INTO academic_session (id,"schoolId",name,"isCurrent","updatedAt") VALUES ($1,$2,'5-year span',false,now())`, [
      sessionAcademicId,
      SA,
    ]);

    // Five years of terms, oldest first, all ENDED and therefore frozen by the
    // term lock — which is exactly what makes them safe to roll up.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCFullYear(start.getUTCFullYear() - YEARS);

    const cursor = new Date(start);
    for (let y = 0; y < YEARS; y++) {
      for (let t = 0; t < TERMS_PER_YEAR; t++) {
        const termId = randomUUID();
        const name = `Y${y + 1} Term ${t + 1}`;
        const termStart = new Date(cursor);
        const termEnd = new Date(cursor);
        termEnd.setUTCDate(termEnd.getUTCDate() + DAYS_PER_TERM);
        await admin.query(
          `INSERT INTO term (id,"schoolId","sessionId",name,sequence,"isCurrent","startDate","endDate","updatedAt")
           VALUES ($1,$2,$3,$4,$5,false,$6,$7,now())`,
          [termId, SA, sessionAcademicId, name, t + 1, termStart, termEnd],
        );
        termIds.push(termId);
        termNames.push(name);
        if (!oldestTermId) oldestTermId = termId;

        // One register per day, every pupil marked. Bulk-inserted: a per-row loop
        // over 1,200 sessions makes this suite the slowest thing in CI.
        const sessRows: string[] = [];
        const sessParams: unknown[] = [];
        const recRows: string[] = [];
        const recParams: unknown[] = [];
        for (let dOff = 0; dOff < DAYS_PER_TERM; dOff++) {
          const day = new Date(termStart);
          day.setUTCDate(day.getUTCDate() + dOff);
          const sessId = randomUUID();
          sessParams.push(sessId, SA, classId, day, HEAD);
          const b = sessParams.length;
          sessRows.push(`($${b - 4},$${b - 3},$${b - 2},$${b - 1},$${b},now())`);
          for (const [pi, u] of pupils.entries()) {
            // A deterministic pattern, so the expected totals are computable.
            const status = (dOff + pi) % 10 === 0 ? "ABSENT" : "PRESENT";
            recParams.push(randomUUID(), SA, sessId, u, status);
            const r = recParams.length;
            recRows.push(`($${r - 4},$${r - 3},$${r - 2},$${r - 1},$${r},now())`);
          }
        }
        await admin.query(
          `INSERT INTO attendance_session (id,"schoolId","classId",date,"takenById","updatedAt") VALUES ${sessRows.join(",")}`,
          sessParams,
        );
        await admin.query(
          `INSERT INTO attendance_record (id,"schoolId","sessionId","studentId",status,"updatedAt") VALUES ${recRows.join(",")}`,
          recParams,
        );
        cursor.setUTCDate(cursor.getUTCDate() + DAYS_PER_TERM + 30);
      }
    }

    const tenantDb = new PrismaTenantService();
    const audit = new AuditLogService();
    rollup = new AttendanceRollupService(tenantDb, audit);
    const region = new SchoolRegionService(tenantDb);
    svc = new AttendanceService(tenantDb, audit, { notifyMany: jest.fn() } as never, {} as never, region, {
      onFinalized: jest.fn(),
    } as never);
  }, 120_000);

  afterAll(async () => {
    await admin.query(`DELETE FROM attendance_term_rollup WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM attendance_record WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM attendance_session WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM enrollment WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM term WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM academic_session WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM class WHERE "schoolId" = $1`, [SA]);
    // audit_log references users, so it goes BEFORE them.
    await admin.query(`DELETE FROM audit_log WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    // Without this the pool keeps the jest worker alive and HANGS CI (CLAUDE.md).
    await prisma.$disconnect();
  });

  it("states the TRUE size of a five-year history, not the size of one page", async () => {
    const expected = YEARS * TERMS_PER_YEAR * DAYS_PER_TERM; // one record per pupil per day
    const first = await svc.getStudentAttendance(head(), pupils[0], { page: 1, pageSize: 100 });
    expect(first.total).toBe(expected); // 900 — the old cap returned 200 and said nothing
    expect(first.records).toHaveLength(100);
  });

  it("reaches the OLDEST year by paging — the records the 200-row cap hid", async () => {
    const total = YEARS * TERMS_PER_YEAR * DAYS_PER_TERM;
    const pageSize = 100;
    const lastPage = Math.ceil(total / pageSize);
    const last = await svc.getStudentAttendance(head(), pupils[0], { page: lastPage, pageSize });
    expect(last.records.length).toBeGreaterThan(0);

    // The oldest record on the last page must genuinely be ~5 years old. Paging
    // that silently re-served page one would still "work" without this.
    const oldest = (last.records as Array<{ session: { date: Date } }>).at(-1)!.session.date;
    const ageYears = (Date.now() - new Date(oldest).getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(ageYears).toBeGreaterThan(YEARS - 1);

    // And page 3 is not page 1 — the offset is really applied.
    const p1 = await svc.getStudentAttendance(head(), pupils[0], { page: 1, pageSize });
    const p3 = await svc.getStudentAttendance(head(), pupils[0], { page: 3, pageSize });
    const ids = (r: { records: unknown[] }) => (r.records as Array<{ id: string }>).map((x) => x.id);
    expect(ids(p3)).not.toEqual(ids(p1));
    expect(ids(p3).some((id) => ids(p1).includes(id))).toBe(false);
  });

  it("opens a term from FIVE YEARS ago on the class board", async () => {
    const board = await svc.getClassAttendance_Grouped(head(), { termId: oldestTermId });
    expect(board.termName).toBe(termNames[0]);
    expect(board.classes).toHaveLength(1);
    expect(board.classes[0].total).toBe(DAYS_PER_TERM * PUPILS);
    expect(board.classes[0].registersTaken).toBe(DAYS_PER_TERM);
    // Nothing is rolled up yet, so it is served live — correct, just slower.
    expect(board.source).toBe("live");
  });

  it("serves that same term from the ROLLUP once computed, with IDENTICAL figures", async () => {
    const before = await svc.getClassAttendance_Grouped(head(), { termId: oldestTermId });
    expect(before.source).toBe("live");

    const staff: Principal = { userId: HEAD, schoolId: SA, roles: ["school_admin"], permissions: ["attendance.write"] };
    const out = await rollup.refreshEndedTerms(staff);
    expect(out.refreshed.length).toBe(YEARS * TERMS_PER_YEAR); // every term has ended

    const after = await svc.getClassAttendance_Grouped(head(), { termId: oldestTermId });
    expect(after.source).toBe("rollup");
    // The claim the whole design rests on: same numbers, different path. Compare
    // the figures themselves, not just the rate — a rate can match by coincidence.
    expect(after.classes[0].present).toBe(before.classes[0].present);
    expect(after.classes[0].absent).toBe(before.classes[0].absent);
    expect(after.classes[0].total).toBe(before.classes[0].total);
    expect(after.classes[0].ratePct).toBe(before.classes[0].ratePct);
  });

  it("lists every term, flagged ended and rolled up", async () => {
    const terms = await svc.listTerms(head());
    expect(terms).toHaveLength(YEARS * TERMS_PER_YEAR);
    expect(terms.every((t) => t.ended)).toBe(true);
    expect(terms.every((t) => t.rolledUp)).toBe(true);
    // Newest first: a head opening this wants last term, not the year they arrived.
    expect(terms[0].name).toBe(termNames.at(-1));
  });
});
