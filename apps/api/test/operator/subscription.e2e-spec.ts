// =============================================================================
// Subscription / module-entitlement integration — real DB, app role, RLS
// =============================================================================
// Proves the platform billing layer end to end:
//   - super_admin sets a school's plan tier -> effective modules follow the bundle
//   - per-school overrides force a module on (add-on) / off (removed)
//   - the cache is invalidated on write so changes take effect immediately
//   - a school can only read its OWN subscription row (RLS cross-tenant deny)
//
// Needs TEST_DATABASE_URL (app role) + TEST_ADMIN_URL (superuser, to seed).
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { MODULES } from "@sms/types";
import { OperatorService } from "../../src/operator/operator.service";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("Subscription / module entitlements (RLS, plan tiers, overrides)", () => {
  let admin: Pool;
  let svc: OperatorService;
  let entitlements: ModuleEntitlementService;

  const SA = randomUUID();
  const SB = randomUUID();
  const UA = randomUUID(); // operator/actor in A
  const operator = (): Principal => ({ userId: UA, schoolId: SA, roles: ["super_admin"], permissions: [] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'SubA',$2,now()),($3,'SubB',$4,now())`,
      [SA, "sa-" + SA, SB, "sb-" + SB],
    );
    await admin.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'Op','x',now())`,
      [UA, SA, UA + "@t"],
    );
    const tenant = new PrismaTenantService() as never;
    entitlements = new ModuleEntitlementService(tenant);
    svc = new OperatorService(tenant, new AuditLogService() as never, entitlements);
  });

  afterAll(async () => {
    for (const t of ["school_subscription", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("defaults to ENTERPRISE (all modules) when no row exists", async () => {
    const sub = await svc.getSubscription(operator(), SA);
    expect(sub.plan).toBe("ENTERPRISE");
    expect(sub.modules).toContain(MODULES.FEES);
    expect(sub.modules).toContain(MODULES.HR);
    expect(sub.modules).toContain(MODULES.GAMES);
  });

  it("BASIC tier excludes higher-tier modules; cache reflects the change at once", async () => {
    const sub = await svc.setSubscription(operator(), SA, { plan: "BASIC" });
    expect(sub.plan).toBe("BASIC");
    expect(sub.modules).toContain(MODULES.LMS);
    expect(sub.modules).not.toContain(MODULES.FEES);
    expect(sub.modules).not.toContain(MODULES.HR);
    // The guard's path: isEnabled reads the (now invalidated → refreshed) cache.
    expect(await entitlements.isEnabled(SA, MODULES.LMS)).toBe(true);
    expect(await entitlements.isEnabled(SA, MODULES.FEES)).toBe(false);
  });

  it("per-school overrides force a module on (add-on) and off (removed)", async () => {
    const sub = await svc.setSubscription(operator(), SA, {
      plan: "STANDARD",
      overrides: { enabled: [MODULES.HR], disabled: [MODULES.FEES] },
    });
    // STANDARD includes fees but we removed it; HR is not in STANDARD but added.
    expect(sub.modules).toContain(MODULES.HR);
    expect(sub.modules).not.toContain(MODULES.FEES);
    expect(sub.modules).toContain(MODULES.LMS); // still in the tier
    expect(await entitlements.isEnabled(SA, MODULES.HR)).toBe(true);
    expect(await entitlements.isEnabled(SA, MODULES.FEES)).toBe(false);
  });

  it("a school cannot read another school's subscription row (RLS)", async () => {
    // School A now has a row (set above). Under B's tenant context it's invisible,
    // so B resolves to the ENTERPRISE default — never A's BASIC/STANDARD posture.
    const tenant = new PrismaTenantService();
    const seenByB = await tenant.runAsTenant({ schoolId: SB, userId: UA }, (tx) =>
      tx.schoolSubscription.findFirst({ where: { schoolId: SA } }),
    );
    expect(seenByB).toBeNull();
  });
});
