// =============================================================================
// Integrity retention/purge — behaviour + cross-tenant safety (DB-level)
// =============================================================================
// Proves the privileged purge (a) deletes only rows older than each school's
// window, (b) never touches another tenant's rows, (c) records an immutable
// run, and (d) leaves the run table read-only for the least-privilege app role.
//
//   TEST_DATABASE_URL -> app role (major_user)  — RLS enforced (assertions)
//   TEST_ADMIN_URL    -> superuser              — stands in for the retention
//                                                 role (BYPASSRLS) + FK seeding
//
// Both must be set or the suite skips (must run in CI, never false-pass).
// =============================================================================

import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@sms/db";
import { IntegrityRetentionService } from "../../src/integrity/retention/integrity-retention.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

const DAY = 86_400_000;

d("Integrity retention purge", () => {
  let appPool: Pool;
  let adminPool: Pool;
  let privileged: PrismaClient;
  let service: IntegrityRetentionService;

  // Two tenants. A is purged with a 30-day window; B is never purged here and
  // must remain fully intact (cross-tenant safety).
  const A = randomUUID();
  const B = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const assessmentA = randomUUID();
  const assessmentB = randomUUID();
  const subA = randomUUID();
  const subB = randomUUID();

  const RETENTION_DAYS = 30;

  // helper: insert one append-only row of each kind at a given age (days old).
  async function seedTelemetry(
    school: string,
    submission: string,
    ageDays: number,
  ) {
    const at = new Date(Date.now() - ageDays * DAY);
    const a = adminPool;
    await a.query(
      `INSERT INTO integrity_signal (id,"schoolId","submissionId",type,severity,source,confidence,evidence,"createdAt")
       VALUES (gen_random_uuid(),$1,$2,'PASTE','INFO','SERVER',0.1,'{}'::jsonb,$3)`,
      [school, submission, at],
    );
    await a.query(
      `INSERT INTO submission_draft (id,"schoolId","submissionId",sequence,"contentHash",content,"createdAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'h','c',$4)`,
      [school, submission, Math.floor(Math.random() * 1e9), at],
    );
    await a.query(
      `INSERT INTO submission_telemetry (id,"schoolId","submissionId",kind,payload,"createdAt")
       VALUES (gen_random_uuid(),$1,$2,'TYPING_CADENCE','{}'::jsonb,$3)`,
      [school, submission, at],
    );
  }

  async function countFor(school: string): Promise<Record<string, number>> {
    const a = adminPool;
    const out: Record<string, number> = {};
    for (const t of ["integrity_signal", "submission_draft", "submission_telemetry"]) {
      const r = await a.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "schoolId" = $1`, [school]);
      out[t] = r.rows[0].n;
    }
    return out;
  }

  async function asApp<T>(school: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_school_id', $1, true)", [school]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  beforeAll(async () => {
    appPool = new Pool({ connectionString: APP_URL });
    adminPool = new Pool({ connectionString: ADMIN_URL });
    privileged = new PrismaClient({ datasourceUrl: ADMIN_URL });
    // The service only needs `db.client`; hand it the privileged client directly.
    service = new IntegrityRetentionService({ client: privileged } as never);

    const a = adminPool;
    await a.query(
      `INSERT INTO school (id,name,slug,"integrityRetentionDays","updatedAt")
       VALUES ($1,'A',$2,$5,now()),($3,'B',$4,$5,now())`,
      [A, `slug-${A}`, B, `slug-${B}`, RETENTION_DAYS],
    );
    await a.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt")
       VALUES ($1,$2,$3,'UA','x',now()),($4,$5,$6,'UB','x',now())`,
      [userA, A, `u_${userA}@t`, userB, B, `u_${userB}@t`],
    );
    await a.query(
      `INSERT INTO assessment (id,"schoolId",title,"createdById","updatedAt")
       VALUES ($1,$2,'TA',$3,now()),($4,$5,'TB',$6,now())`,
      [assessmentA, A, userA, assessmentB, B, userB],
    );
    await a.query(
      `INSERT INTO submission (id,"schoolId","assessmentId","studentId","updatedAt")
       VALUES ($1,$2,$3,$4,now()),($5,$6,$7,$8,now())`,
      [subA, A, assessmentA, userA, subB, B, assessmentB, userB],
    );

    // School A: 2 old (400d) + 1 recent of each kind. School B: 1 old of each.
    await seedTelemetry(A, subA, 400);
    await seedTelemetry(A, subA, 400);
    await seedTelemetry(A, subA, 1);
    await seedTelemetry(B, subB, 400);
  });

  afterAll(async () => {
    const a = adminPool;
    for (const t of [
      "integrity_retention_run",
      "integrity_signal",
      "submission_draft",
      "submission_telemetry",
      "submission",
      "assessment",
    ]) {
      await a.query(`DELETE FROM "${t}" WHERE "schoolId" = ANY($1)`, [[A, B]]);
    }
    await a.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[A, B]]);
    await a.query(`DELETE FROM school WHERE id = ANY($1)`, [[A, B]]);
    await privileged.$disconnect();
    await appPool.end();
    await adminPool.end();
  });

  it("purges only rows older than the school's window, and records the run", async () => {
    const result = await service.purgeSchool(A, RETENTION_DAYS, "SCHEDULED");

    // 2 old of each kind deleted; the 1 recent of each kind survives.
    expect(result.signalsDeleted).toBe(2);
    expect(result.draftsDeleted).toBe(2);
    expect(result.telemetryDeleted).toBe(2);

    const after = await countFor(A);
    expect(after.integrity_signal).toBe(1);
    expect(after.submission_draft).toBe(1);
    expect(after.submission_telemetry).toBe(1);

    // An immutable run record was written for school A.
    const runs = await adminPool.query(
      `SELECT "signalsDeleted","draftsDeleted","telemetryDeleted",trigger
         FROM integrity_retention_run WHERE "schoolId" = $1`,
      [A],
    );
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0].trigger).toBe("SCHEDULED");
    expect(runs.rows[0].signalsDeleted).toBe(2);
  });

  it("never touches another tenant's rows", async () => {
    // School B was seeded with 1 old row of each kind and never purged.
    const b = await countFor(B);
    expect(b.integrity_signal).toBe(1);
    expect(b.submission_draft).toBe(1);
    expect(b.submission_telemetry).toBe(1);
  });

  it("treats a 0-day window as DISABLED (purges nothing)", async () => {
    const result = await service.purgeSchool(B, 0, "MANUAL");
    expect(result.skipped).toBe("DISABLED");
    expect(result.signalsDeleted).toBe(0);
    const b = await countFor(B);
    expect(b.integrity_signal).toBe(1); // untouched
  });

  it("retention run is readable by the app role but immutable (no UPDATE/DELETE)", async () => {
    // App role (school A context) can read its own retention history (RLS SELECT).
    await asApp(A, async (c) => {
      const r = await c.query(`SELECT 1 FROM integrity_retention_run WHERE "schoolId" = $1`, [A]);
      expect(r.rowCount).toBe(1);
    });
    // ...but cannot tamper with it (no UPDATE/DELETE policy + privilege revoked).
    await asApp(A, async (c) => {
      await expect(
        c.query(`UPDATE integrity_retention_run SET "signalsDeleted" = 0 WHERE "schoolId" = $1`, [A]),
      ).rejects.toThrow();
    });
    await asApp(A, async (c) => {
      await expect(
        c.query(`DELETE FROM integrity_retention_run WHERE "schoolId" = $1`, [A]),
      ).rejects.toThrow();
    });
    // And cross-tenant: school B cannot see A's run.
    await asApp(B, async (c) => {
      const r = await c.query(`SELECT 1 FROM integrity_retention_run WHERE "schoolId" = $1`, [A]);
      expect(r.rowCount).toBe(0);
    });
  });
});
