// =============================================================================
// TimetableService integration — real DB, app role, RLS in force
// =============================================================================
// Proves CSP auto-generation end to end against Postgres:
//   - teacher availability CRUD (staff set/list; a teacher sees only their own)
//   - generate() satisfies per-offering quotas, honours unavailability, pins
//     preferred rooms, and persists a clash-free grid (verified BY QUERY)
//   - structurally impossible demand surfaces as name-resolved diagnostics +
//     per-lesson unplaced reasons, never a bare failure
//   - cross-tenant: another school's generate sees NO offerings (RLS)
//   - non-school-wide staff cannot generate (403)
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma singleton)
// + TEST_ADMIN_URL (superuser, to seed). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { TimetableService } from "../../src/timetable/timetable.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("TimetableService integration (CSP auto-generation, RLS)", () => {
  let admin: Pool;
  let svc: TimetableService;

  const SA = randomUUID();
  const SB = randomUUID();
  const ADM = randomUUID(); // school_admin in SA
  const T1 = randomUUID(); // teaches Math in C1 + C2
  const T2 = randomUUID(); // teaches Chemistry in C1 (fixed room LAB)
  const ADMB = randomUUID(); // school_admin in SB
  const C1 = randomUUID();
  const C2 = randomUUID();
  const MATH = randomUUID();
  const CHEM = randomUUID();
  const LAB = randomUUID();
  const periods = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const DAYS = ["MONDAY", "TUESDAY"] as const;

  const staff = (): Principal => ({ userId: ADM, schoolId: SA, roles: ["school_admin"], permissions: [] });
  const teacher = (u: string): Principal => ({ userId: u, schoolId: SA, roles: ["teacher"], permissions: [] });
  const staffB = (): Principal => ({ userId: ADMB, schoolId: SB, roles: ["school_admin"], permissions: [] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'TTA',$2,now()),($3,'TTB',$4,now())`,
      [SA, "tta-" + SA, SB, "ttb-" + SB],
    );
    for (const [u, s, name] of [
      [ADM, SA, "Admin"],
      [T1, SA, "Amaka Obi"],
      [T2, SA, "Bola Ade"],
      [ADMB, SB, "Admin B"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@tt", name],
      );
    }
    for (const [c, name] of [
      [C1, "TT Class 1"],
      [C2, "TT Class 2"],
    ] as const) {
      await admin.query(`INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,$3,now())`, [c, SA, name]);
    }
    for (const [s, name] of [
      [MATH, "Mathematics"],
      [CHEM, "Chemistry"],
    ] as const) {
      await admin.query(`INSERT INTO subject (id,"schoolId",name,"updatedAt") VALUES ($1,$2,$3,now())`, [s, SA, name]);
    }
    await admin.query(`INSERT INTO room (id,"schoolId",name,"updatedAt") VALUES ($1,$2,'Science Lab',now())`, [LAB, SA]);
    for (let i = 0; i < periods.length; i++) {
      await admin.query(
        `INSERT INTO period (id,"schoolId",name,sequence,"startTime","endTime","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [periods[i], SA, `P${i + 1}`, i + 1, `${String(8 + i).padStart(2, "0")}:00`, `${String(8 + i).padStart(2, "0")}:45`],
      );
    }
    // Offerings: quotas + Chemistry pinned to the lab.
    for (const [cls, subj, t, quota, room] of [
      [C1, MATH, T1, 3, null],
      [C1, CHEM, T2, 2, LAB],
      [C2, MATH, T1, 2, null],
    ] as const) {
      await admin.query(
        `INSERT INTO class_subject_teacher (id,"schoolId","classId","subjectId","teacherId","lessonsPerWeek","preferredRoomId")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), SA, cls, subj, t, quota, room],
      );
    }
    const tenant = new PrismaTenantService() as never;
    svc = new TimetableService(tenant, new AuditLogService() as never);
  });

  afterAll(async () => {
    for (const t of [
      "timetable_entry",
      "teacher_unavailability",
      "class_subject_teacher",
      "subject",
      "period",
      "room",
      "class",
      "audit_log",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
  });

  it("staff set a teacher's unavailability; the teacher lists only their own", async () => {
    const res = await svc.setUnavailability(staff(), T1, [{ dayOfWeek: "TUESDAY", periodId: periods[0] }]);
    expect(res).toEqual({ ok: true, slots: 1 });

    const all = await svc.listUnavailability(staff());
    expect(all).toEqual([{ teacherId: T1, dayOfWeek: "TUESDAY", periodId: periods[0] }]);

    // A teacher's view is forced to their own rows — T2 sees nothing, T1 theirs.
    expect(await svc.listUnavailability(teacher(T2), T1)).toEqual([]);
    expect(await svc.listUnavailability(teacher(T1))).toHaveLength(1);
  });

  it("rejects an availability set naming an unknown period", async () => {
    await expect(
      svc.setUnavailability(staff(), T1, [{ dayOfWeek: "MONDAY", periodId: randomUUID() }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("generates a complete, clash-free grid honouring quotas, availability, and rooms", async () => {
    const res = await svc.generate(staff(), { days: [...DAYS], replace: true });
    expect(res.complete).toBe(true);
    expect(res.placed).toBe(7); // 3 + 2 + 2 lessons
    expect(res.unplaced).toEqual([]);
    expect(res.diagnostics).toEqual([]);

    // Quotas persisted exactly, Chemistry pinned to the lab.
    const bySubject = await admin.query<{ classId: string; subject: string; n: string }>(
      `SELECT "classId", subject, count(*)::text AS n FROM timetable_entry WHERE "schoolId"=$1 GROUP BY 1,2`,
      [SA],
    );
    const count = (cls: string, subj: string) =>
      Number(bySubject.rows.find((r) => r.classId === cls && r.subject === subj)?.n ?? 0);
    expect(count(C1, "Mathematics")).toBe(3);
    expect(count(C1, "Chemistry")).toBe(2);
    expect(count(C2, "Mathematics")).toBe(2);
    const chem = await admin.query<{ roomId: string | null }>(
      `SELECT "roomId" FROM timetable_entry WHERE "schoolId"=$1 AND subject='Chemistry'`,
      [SA],
    );
    expect(chem.rows.every((r) => r.roomId === LAB)).toBe(true);

    // T1 never sits in their unavailable slot.
    const clash = await admin.query(
      `SELECT 1 FROM timetable_entry WHERE "schoolId"=$1 AND "teacherId"=$2 AND "dayOfWeek"='TUESDAY' AND "periodId"=$3`,
      [SA, T1, periods[0]],
    );
    expect(clash.rowCount).toBe(0);

    // No teacher/class/room double-booking anywhere (the DB is the witness).
    for (const col of ['"teacherId"', '"classId"', '"roomId"']) {
      const dup = await admin.query(
        `SELECT 1 FROM timetable_entry WHERE "schoolId"=$1 AND ${col} IS NOT NULL
         GROUP BY ${col},"dayOfWeek","periodId" HAVING count(*) > 1`,
        [SA],
      );
      expect(dup.rowCount).toBe(0);
    }
  });

  it("surfaces impossible demand as name-resolved diagnostics + unplaced reasons", async () => {
    // Block T2 (Chemistry, 2 lessons) out of 7 of the 8 slots — capacity 1.
    const blocked: { dayOfWeek: "MONDAY" | "TUESDAY"; periodId: string }[] = [];
    for (const day of DAYS) {
      for (const pid of periods) {
        if (day === "MONDAY" && pid === periods[0]) continue;
        blocked.push({ dayOfWeek: day, periodId: pid });
      }
    }
    await svc.setUnavailability(staff(), T2, blocked);

    const res = await svc.generate(staff(), { days: [...DAYS], replace: true });
    expect(res.complete).toBe(false);
    expect(res.diagnostics).toContainEqual({ kind: "TEACHER_OVERLOAD", name: "Bola Ade", demand: 2, capacity: 1 });
    expect(res.unplaced).toHaveLength(1);
    expect(res.unplaced[0]).toMatchObject({ className: "TT Class 1", subject: "Chemistry", teacherName: "Bola Ade" });
    expect(res.unplaced[0].reason).toContain("unavailability");
    // Best effort still landed everything placeable.
    expect(res.placed).toBe(6);

    await svc.setUnavailability(staff(), T2, []); // restore
  });

  it("cross-tenant: school B sees none of school A's offerings (RLS)", async () => {
    await expect(svc.generate(staffB(), { replace: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(await svc.listUnavailability(staffB())).toEqual([]);
  });

  it("non-school-wide staff cannot generate or set availability", async () => {
    await expect(svc.generate(teacher(T1), {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setUnavailability(teacher(T1), T1, [])).rejects.toBeInstanceOf(ForbiddenException);
  });
});
