// =============================================================================
// RaceService integration — real DB, app role, RLS in force (spec §5)
// =============================================================================
// Proves the Class Race layer end to end against Postgres:
//   - a teacher opens a race, enrolled students join, host starts it
//   - parallel play: first three to crack the shared target win (1st/2nd/3rd)
//   - a racer sees ONLY their own guesses; the target is NEVER serialized (§9)
//   - guesses are rate-limited (anti-abuse, §5)
//   - non-enrolled / cross-tenant access 404s (never 403)
//   - a cross-class tournament keeps per-class + combined standings
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma singleton)
// + TEST_ADMIN_URL (superuser, to seed). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { RaceService } from "../../src/game/race.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("RaceService integration (Class Race + tournament, RLS, server authority)", () => {
  let admin: Pool;
  let svc: RaceService;

  const SA = randomUUID();
  const SB = randomUUID();
  const T = randomUUID(); // teacher of CLS and CLS2
  const PR = randomUUID(); // principal (school-wide)
  const S1 = randomUUID();
  const S2 = randomUUID();
  const S3 = randomUUID();
  const S4 = randomUUID(); // NOT enrolled in CLS
  const S5 = randomUUID(); // enrolled in CLS2
  const S6 = randomUUID(); // enrolled in CLS2
  const SBU = randomUUID(); // other tenant
  const CLS = randomUUID();
  const CLS2 = randomUUID();

  const teacher = (): Principal => ({ userId: T, schoolId: SA, roles: ["teacher"], permissions: [] });
  const principal = (): Principal => ({ userId: PR, schoolId: SA, roles: ["principal"], permissions: [] });
  const student = (u: string, s = SA): Principal => ({ userId: u, schoolId: s, roles: ["student"], permissions: [] });

  const targetOf = async (raceId: string): Promise<string> => {
    const r = await admin.query<{ targetSecret: string }>(
      `SELECT "targetSecret" FROM game WHERE id = $1`,
      [raceId],
    );
    return r.rows[0]!.targetSecret;
  };
  const noTarget = (v: unknown, target: string) =>
    expect(JSON.stringify(v)).not.toContain(target);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RA',$2,now()),($3,'RB',$4,now())`,
      [SA, "ra-" + SA, SB, "rb-" + SB],
    );
    for (const [u, s, name] of [
      [T, SA, "Teach"],
      [PR, SA, "Principal"],
      [S1, SA, "S1"],
      [S2, SA, "S2"],
      [S3, SA, "S3"],
      [S4, SA, "S4"],
      [S5, SA, "S5"],
      [S6, SA, "S6"],
      [SBU, SB, "Other"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, s, u + "@t", name],
      );
    }
    for (const [c, name] of [
      [CLS, "Class A"],
      [CLS2, "Class B"],
    ] as const) {
      await admin.query(
        `INSERT INTO class (id,"schoolId",name,"updatedAt") VALUES ($1,$2,$3,now())`,
        [c, SA, name],
      );
      await admin.query(
        `INSERT INTO class_teacher (id,"schoolId","classId","teacherId") VALUES ($1,$2,$3,$4)`,
        [randomUUID(), SA, c, T],
      );
    }
    for (const [stu, cls] of [
      [S1, CLS],
      [S2, CLS],
      [S3, CLS],
      [S5, CLS2],
      [S6, CLS2],
    ] as const) {
      await admin.query(
        `INSERT INTO enrollment (id,"schoolId","classId","studentId") VALUES ($1,$2,$3,$4)`,
        [randomUUID(), SA, cls, stu],
      );
    }
    const tenant = new PrismaTenantService() as never;
    svc = new RaceService(tenant, new AuditLogService() as never);
  });

  afterAll(async () => {
    for (const t of ["guess", "game_result", "game_player", "game", "standing", "competition"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    for (const t of ["enrollment", "class_teacher", "class", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("opens a race, students join, host starts, top-3 win in finish order", async () => {
    const opened = await svc.openRace(teacher(), { classId: CLS, difficultyLength: 4 });
    expect(opened.status).toBe("LOBBY");
    expect(opened.you).toBeNull(); // the host is not a participant
    const raceId = opened.id;

    await svc.joinRace(student(S1), raceId);
    await svc.joinRace(student(S2), raceId);
    await svc.joinRace(student(S3), raceId);
    const started = await svc.startRace(teacher(), raceId);
    expect(started.status).toBe("ACTIVE");
    expect(started.participantCount).toBe(3);

    const target = await targetOf(raceId);
    // Each cracks on their first guess → finish order = call order.
    expect(await svc.guess(student(S1), raceId, target)).toEqual({ dead: 4, wounded: 0 });
    expect(await svc.guess(student(S2), raceId, target)).toEqual({ dead: 4, wounded: 0 });
    await svc.guess(student(S3), raceId, target); // 3rd finisher → race ends

    const view = await svc.getRace(student(S1), raceId);
    expect(view.status).toBe("FINISHED");
    expect(view.winnerUserId).toBe(S1);
    expect(view.leaderboard.map((f) => f.userId)).toEqual([S1, S2, S3]);
    expect(view.leaderboard.map((f) => f.rank)).toEqual([1, 2, 3]);
    expect(view.yourFinish).toMatchObject({ rank: 1, guessCount: 1 });
    // S1's own cracking guess necessarily equals the target and shows in THEIR
    // guess history — that's the guess, not a leak. The invariants: the server
    // cleared the stored target, and the PUBLIC leaderboard never carries it.
    expect(await targetOf(raceId)).toBeNull();
    noTarget(view.leaderboard, target);
  });

  it("redacts: a racer sees only their own guesses, never the target", async () => {
    const opened = await svc.openRace(teacher(), { classId: CLS, difficultyLength: 4 });
    await svc.joinRace(student(S1), opened.id);
    await svc.joinRace(student(S2), opened.id);
    await svc.startRace(teacher(), opened.id);
    const target = await targetOf(opened.id);
    const rev = target.split("").reverse().join(""); // valid, never a win (distinct digits)
    await svc.guess(student(S1), opened.id, rev); // S1 makes a non-winning guess

    const s2view = await svc.getRace(student(S2), opened.id);
    expect(s2view.yourGuesses).toHaveLength(0); // S2 sees none of S1's guesses
    const s1view = await svc.getRace(student(S1), opened.id);
    expect(s1view.yourGuesses).toHaveLength(1);
    noTarget(s2view, target);
    noTarget(s1view, target);
  });

  it("rate-limits rapid-fire guesses", async () => {
    const opened = await svc.openRace(teacher(), { classId: CLS, difficultyLength: 4 });
    await svc.joinRace(student(S1), opened.id);
    await svc.startRace(teacher(), opened.id);
    const target = await targetOf(opened.id);
    const rev = target.split("").reverse().join("");
    await svc.guess(student(S1), opened.id, rev); // first non-winning guess OK
    await expect(svc.guess(student(S1), opened.id, rev)).rejects.toThrow(); // immediate 2nd → 429
  });

  it("blocks non-enrolled and cross-tenant access with 404", async () => {
    const opened = await svc.openRace(teacher(), { classId: CLS, difficultyLength: 4 });
    // S4 is not enrolled in CLS → cannot join, cannot view.
    await expect(svc.joinRace(student(S4), opened.id)).rejects.toThrow(/not found/i);
    await expect(svc.getRace(student(S4), opened.id)).rejects.toThrow(/not found/i);
    // Other tenant → RLS hides it.
    await expect(svc.getRace(student(SBU, SB), opened.id)).rejects.toThrow(/not found/i);
  });

  it("listRaces is relationship-scoped (enrolled/teacher/school-wide see it; others don't)", async () => {
    const opened = await svc.openRace(teacher(), { classId: CLS, difficultyLength: 4 });
    const has = (rows: { id: string }[]) => rows.some((r) => r.id === opened.id);

    // Enrolled student (CLS), the teacher of CLS, and a school-wide principal see it.
    expect(has(await svc.listRaces(student(S1)))).toBe(true);
    expect(has(await svc.listRaces(teacher()))).toBe(true);
    expect(has(await svc.listRaces(principal()))).toBe(true);
    // A student enrolled only in CLS2 does NOT see a CLS race they haven't joined.
    expect(has(await svc.listRaces(student(S5)))).toBe(false);
    // A non-enrolled same-school student doesn't see it either.
    expect(has(await svc.listRaces(student(S4)))).toBe(false);
    // Cross-tenant: RLS hides it entirely.
    expect(has(await svc.listRaces(student(SBU, SB)))).toBe(false);

    // The summary never carries the target secret (server authority, §9).
    const rows = await svc.listRaces(student(S1));
    noTarget(rows, await targetOf(opened.id));
  });

  it("rejects a teacher opening a race for a class they don't teach", async () => {
    const stranger: Principal = { userId: S1, schoolId: SA, roles: ["teacher"], permissions: [] };
    await expect(
      svc.openRace(stranger, { classId: CLS, difficultyLength: 4 }),
    ).rejects.toThrow(/not found/i);
  });

  it("runs a cross-class tournament with per-class + combined standings", async () => {
    const t = await svc.openTournament(principal(), {
      name: "Inter-Class Cup",
      classIds: [CLS, CLS2],
      difficultyLength: 4,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 864e5).toISOString(),
    });
    expect(t.status).toBe("ACTIVE");
    expect(t.classRaceIds).toHaveLength(2);
    expect(t.perClass).toHaveLength(2);

    // Play out each class race: one student cracks each, in one guess.
    for (const raceId of t.classRaceIds) {
      const detail = await svc.getRace(principal(), raceId);
      const classId = detail.classId;
      const joiner = classId === CLS ? S1 : S5;
      await svc.joinRace(student(joiner), raceId);
      await svc.startRace(principal(), raceId);
      const target = await targetOf(raceId);
      await svc.guess(student(joiner), raceId, target);
    }

    const final = await svc.getTournament(principal(), t.id);
    expect(final.status).toBe("FINISHED");
    expect(final.combined).toHaveLength(2);
    expect(final.combined.every((r) => r.rank >= 1)).toBe(true);
    // Both cracked in one guess → tie-broken by own-start elapsed; ranks assigned.
    expect(new Set(final.combined.map((r) => r.userId))).toEqual(new Set([S1, S5]));
  });
});
