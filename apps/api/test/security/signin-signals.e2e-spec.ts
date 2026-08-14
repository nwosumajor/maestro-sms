// =============================================================================
// A signal nobody is shown is not a signal
// =============================================================================
// #187 started recording sign-ins, failed attempts and lockouts. That was half
// the job. The events landed in `audit_log`, and the two places a human looks
// for exactly this kind of thing did not change:
//
//   * the audit viewer's quick filters offered security. / medical / fee. /
//     document. / attendance. and no `auth.`, so the rows existed and nothing
//     offered a route to them (the filter matches by `contains`, so you had to
//     know to type it);
//   * the security console's anomaly report counted break-glass elevations and
//     heavy medical-record readers — both good signals — while the classic one,
//     an account being guessed at until it locked, was absent.
//
// That is the same shape as every defect this review keeps turning up: the
// writer was added, the readers were not. It is worth stating plainly that it
// happened again in the change that fixed the previous instance.
//
// This suite runs against Postgres because the signal is an aggregate over real
// audit rows: a mocked tx would return whatever it was told and prove nothing
// about the grouping, the lockout flag, or the window.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { SecurityService } from "../../src/security/security.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

const SCHOOL = randomUUID();
const ADMIN_USER = randomUUID();
const GUESSED_AT = randomUUID();   // locked after repeated failures
const FORGETFUL = randomUUID();    // a couple of misses, never locked
const UNTROUBLED = randomUUID();   // signs in cleanly

d("sign-in signals reach the security console (real Postgres)", () => {
  let admin: Pool;
  let security: SecurityService;

  const principal: Principal = {
    schoolId: SCHOOL,
    userId: ADMIN_USER,
    roles: ["school_admin"],
    permissions: ["security.audit.read"],
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'Signals',$2,now())`, [
      SCHOOL,
      "signals-" + SCHOOL,
    ]);
    for (const [id, name] of [
      [ADMIN_USER, "The Admin"],
      [GUESSED_AT, "Guessed At"],
      [FORGETFUL, "Forgetful Teacher"],
      [UNTROUBLED, "Untroubled"],
    ] as Array<[string, string]>) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SCHOOL, `${id}@signals.test`, name],
      );
    }

    // The audit rows #187 now writes, exactly as the login path writes them.
    const event = (actorId: string, action: string, meta: object, agoMs = 0) =>
      admin.query(
        // $3 and $5 are the same value deliberately: reusing one placeholder for
        // both actorId and entityId leaves Postgres unable to deduce a single
        // type for it ("inconsistent types deduced for parameter $3").
        `INSERT INTO audit_log (id,"schoolId","actorId",action,entity,"entityId",metadata,"createdAt")
         VALUES ($1,$2,$3,$4,'user',$5,$6,now() - ($7 || ' milliseconds')::interval)`,
        [randomUUID(), SCHOOL, actorId, action, actorId, JSON.stringify(meta), String(agoMs)],
      );

    for (let i = 1; i <= 2; i++) await event(GUESSED_AT, "auth.login.failed", { failedLoginCount: i });
    await event(GUESSED_AT, "auth.account.locked", { failedLoginCount: 3, locked: true });
    await event(FORGETFUL, "auth.login.failed", { failedLoginCount: 1 });
    await event(FORGETFUL, "auth.login.failed", { failedLoginCount: 2 });
    await event(UNTROUBLED, "auth.login", {});
    // Outside the 30-day window: must not be counted.
    await event(UNTROUBLED, "auth.login.failed", { failedLoginCount: 1 }, 40 * 86_400_000);

    security = new SecurityService(new PrismaTenantService() as never, new AuditLogService());
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM audit_log WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SCHOOL]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SCHOOL]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("counts the accounts that actually locked, not the failures", async () => {
    // One account locked; the other missed twice and is fine. Counting failures
    // would report two and send an operator after someone who just mistyped.
    const a = await security.anomalies(principal);
    expect(a.lockedOutCount).toBe(1);
  });

  it("ranks accounts by attempts, worst first, and flags the locked one", async () => {
    const a = await security.anomalies(principal);
    expect(a.topFailedLogins[0]).toEqual({ actorName: "Guessed At", count: 3, locked: true });
    expect(a.topFailedLogins[1]).toEqual({ actorName: "Forgetful Teacher", count: 2, locked: false });
  });

  it("counts a lockout as an attempt, since it IS one", async () => {
    // Two auth.login.failed plus the auth.account.locked third strike = 3. If
    // the lockout were excluded the worst account would read as the mildest.
    const a = await security.anomalies(principal);
    expect(a.topFailedLogins.find((r) => r.actorName === "Guessed At")?.count).toBe(3);
  });

  it("ignores events outside the window", async () => {
    // A 40-day-old failure must not keep an account on the list forever.
    const a = await security.anomalies(principal);
    expect(a.topFailedLogins.some((r) => r.actorName === "Untroubled")).toBe(false);
  });

  it("does not list a clean sign-in as trouble", async () => {
    const a = await security.anomalies(principal);
    expect(a.topFailedLogins.every((r) => r.count > 0)).toBe(true);
  });

  it("still reports the signals it always did", async () => {
    // Added beside break-glass and medical reads, not instead of them.
    const a = await security.anomalies(principal);
    expect(a).toHaveProperty("breakGlassCount");
    expect(a).toHaveProperty("topMedicalReaders");
  });
});
