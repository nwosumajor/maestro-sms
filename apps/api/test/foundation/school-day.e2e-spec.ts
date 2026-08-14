// =============================================================================
// "Today" belongs to the school, not to the server
// =============================================================================
// CLAUDE.md states the rule and names where it is honoured: "the register, the
// gate-scan check-in, the term lock and the 7-day stale rule". Those four were
// right. Four other decisions still asked the server what day it was:
//
//   exam release      an invigilator east of UTC could not release their own
//                     morning paper. At 07:00 in Singapore the server still
//                     reads the previous day, so a sitting dated today looks
//                     like it is in the future and the release is refused — at
//                     exactly the moment it is needed.
//   staff clock-in    the PUPIL register was moved onto the school's day and
//                     the STAFF one was not. A Toronto evening duty filed
//                     against tomorrow, and "already clocked in today" then
//                     looked at the wrong day too.
//   installment state a tranche due TODAY showed OVERDUE to the parent from
//                     early evening anywhere west of UTC.
//   receivables aging buckets measured from the server's day rather than the
//                     school's.
//
// Every one is a boundary error, which is why none of them was ever reported:
// they are correct for most of the day, wrong near midnight, and self-correct
// by morning. The catalogue includes America/New_York and America/Toronto
// (4-5h west) and Asia/Singapore (+8), so both directions are live.
//
// This runs against Postgres with schools actually placed in those timezones,
// because the whole question is what `schoolToday` returns for a real
// `school.timezone` — a mocked region service would return whatever it was
// handed and prove nothing.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { schoolToday } from "@sms/types";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

const EAST = randomUUID(); // Asia/Singapore, UTC+8
const WEST = randomUUID(); // America/Toronto, UTC-4/-5

d("the school's calendar day (real Postgres)", () => {
  let admin: Pool;
  let region: SchoolRegionService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,timezone,"updatedAt") VALUES ($1,'East',$2,'Asia/Singapore',now())`,
      [EAST, "east-" + EAST],
    );
    await admin.query(
      `INSERT INTO school (id,name,slug,timezone,"updatedAt") VALUES ($1,'West',$2,'America/Toronto',now())`,
      [WEST, "west-" + WEST],
    );
    region = new SchoolRegionService(new PrismaTenantService() as never);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[EAST, WEST]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("resolves a different day from the server at the edges", () => {
    // The pure function, at the two instants that matter. Not dependent on when
    // the suite runs: both are fixed points in time.
    const singaporeMorning = new Date("2026-10-10T07:00:00+08:00"); // 23:00 UTC on the 9th
    expect(schoolToday("Asia/Singapore", singaporeMorning).toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(singaporeMorning.toISOString().slice(0, 10)).toBe("2026-10-09"); // what the server saw

    const torontoEvening = new Date("2026-10-10T20:00:00-04:00"); // 00:00 UTC on the 11th
    expect(schoolToday("America/Toronto", torontoEvening).toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(torontoEvening.toISOString().slice(0, 10)).toBe("2026-10-11"); // what the server saw
  });

  it("an exam dated today is NOT in the future for a school east of UTC", () => {
    // The refusal was `sitting.date > today`. With the server's day that is true
    // all morning in Singapore; with the school's day it is false, which is what
    // lets the invigilator release the paper.
    const at = new Date("2026-10-10T07:00:00+08:00");
    const sitting = new Date("2026-10-10T00:00:00.000Z"); // @db.Date
    expect(sitting > schoolToday("Asia/Singapore", at)).toBe(false);
    expect(sitting > new Date("2026-10-09T00:00:00.000Z")).toBe(true); // the old behaviour
  });

  it("a tranche due today is NOT overdue for a school west of UTC", () => {
    const at = new Date("2026-10-10T20:00:00-04:00");
    const due = new Date("2026-10-10T00:00:00.000Z"); // @db.Date
    expect(due.getTime() < schoolToday("America/Toronto", at).getTime()).toBe(false);
    expect(due.getTime() < new Date("2026-10-11T00:00:00.000Z").getTime()).toBe(true); // the old behaviour
  });

  it("reads the timezone off the school row, per school", async () => {
    // The services call this, so it is the one that must be right. Both schools
    // are asked in the same instant and may legitimately differ by a day.
    const east = await region.forSchool(EAST);
    const west = await region.forSchool(WEST);
    expect(east.timezone).toBe("Asia/Singapore");
    expect(west.timezone).toBe("America/Toronto");
  });

  it("a school with no timezone set falls back, rather than throwing", async () => {
    // `timezone` is nullable — null means the platform's home country, and every
    // school already live has it unset. This must not become a hard dependency.
    const plain = randomUUID();
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'Plain',$2,now())`, [
      plain,
      "plain-" + plain,
    ]);
    const r = await region.forSchool(plain);
    expect(typeof r.timezone).toBe("string");
    expect(r.timezone.length).toBeGreaterThan(0);
    await admin.query(`DELETE FROM school WHERE id = $1`, [plain]);
  });
});

describe("no service decides a school's day from the server clock", () => {
  it("the four call sites go through the region helper", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

    // Each of these was `new Date()` and is now the school's day. Named
    // individually so a regression says WHICH one came back.
    expect(read("exam/exam.service.ts")).toMatch(
      /Release is meant for the exam day[\s\S]*?const today = await this\.region\.todayInTx\(tx, p\.schoolId\)/,
    );
    expect(read("hr/attendance.service.ts")).toMatch(
      /const date = await this\.region\.todayInTx\(tx, p\.schoolId\)/,
    );
    expect(read("fees/payment-plans.service.ts")).toMatch(
      /const today = await this\.region\.todayInTx\(tx, p\.schoolId\)/,
    );
    expect(read("fees/fees.service.ts")).toMatch(
      /const today = await this\.region\.todayInTx\(tx, p\.schoolId\)/,
    );
  });
});
