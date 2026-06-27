// =============================================================================
// BillingService integration — real DB, app role, RLS in force (revenue layer)
// =============================================================================
// Proves the platform billing engine end to end:
//   - checkout is gracefully disabled (503) when PAYSTACK_SECRET_KEY is unset
//   - the verified webhook applies a PENDING payment: marks it PAID, sets the
//     subscription ACTIVE + plan + currentPeriodEnd (and is IDEMPOTENT)
//   - the dunning sweep flips an elapsed ACTIVE subscription to PAST_DUE, and the
//     entitlement resolver then enforces BASIC modules past the grace window
//     WITHOUT mutating the purchased plan
//
// Needs TEST_DATABASE_URL (app role) + TEST_ADMIN_URL (superuser, to seed +
// privileged dunning). Skips otherwise so it never false-passes.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { PrismaClient, prisma } from "@sms/db";
import { MODULES } from "@sms/types";
import { BillingService } from "../../src/billing/billing.service";
import { BillingDunningService } from "../../src/billing/billing-dunning.service";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { PaystackService, type PaystackEvent } from "../../src/payments/paystack.service";
import type { NotificationService } from "../../src/notifications/notification.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("BillingService integration (per-seat checkout, webhook, dunning, RLS)", () => {
  let admin: Pool;
  let privileged: PrismaClient;
  let billing: BillingService;
  let entitlements: ModuleEntitlementService;

  const SA = randomUUID();
  const SB = randomUUID();
  const UA = randomUUID(); // school_admin in A (initiator)
  const REF = `SUB-${SA.slice(0, 8)}-${Date.now()}`;
  const savedKey = process.env.PAYSTACK_SECRET_KEY;

  const staff = (): Principal => ({ userId: UA, schoolId: SA, roles: ["school_admin"], permissions: [] });

  const subRow = async (schoolId: string) => {
    const r = await admin.query(
      `SELECT plan,status,"currentPeriodEnd" FROM school_subscription WHERE "schoolId" = $1`,
      [schoolId],
    );
    return r.rows[0] as { plan: string; status: string; currentPeriodEnd: Date | null } | undefined;
  };

  beforeAll(async () => {
    delete process.env.PAYSTACK_SECRET_KEY; // checkout disabled path
    admin = new Pool({ connectionString: ADMIN_URL });
    privileged = new PrismaClient({ datasourceUrl: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'BillA',$2,now()),($3,'BillB',$4,now())`,
      [SA, "ba-" + SA, SB, "bb-" + SB],
    );
    await admin.query(
      `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'Admin','x',now())`,
      [UA, SA, UA + "@t"],
    );

    const tenant = new PrismaTenantService() as never;
    entitlements = new ModuleEntitlementService(tenant);
    const notifications = { enqueue: async () => undefined } as unknown as NotificationService;
    const dunning = new BillingDunningService(
      { client: privileged } as never,
      entitlements,
      notifications,
    );
    billing = new BillingService(
      tenant,
      new AuditLogService() as never,
      entitlements,
      notifications,
      new PaystackService(),
      dunning,
    );
  });

  afterAll(async () => {
    for (const t of ["platform_subscription_payment", "school_subscription", "audit_log", "notification"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await privileged.$disconnect();
    await prisma.$disconnect();
    if (savedKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = savedKey;
  });

  it("checkout is disabled (503) when the gateway is not configured", async () => {
    await expect(billing.initCheckout(staff(), { plan: "STANDARD", billingCycle: "TERM" })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("the verified webhook applies a PENDING payment: PAID + ACTIVE + period set", async () => {
    // Seed a PENDING payment as if checkout had created it.
    await admin.query(
      `INSERT INTO platform_subscription_payment
         (id,"schoolId",plan,"billingCycle",seats,"amountMinor",reference,status,"initiatedById","updatedAt")
       VALUES ($1,$2,'STANDARD','TERM',400,$3,$4,'PENDING',$5,now())`,
      [randomUUID(), SA, 400 * 20_000 * 4, REF, UA],
    );

    const event: PaystackEvent = {
      event: "charge.success",
      data: { amount: 400 * 20_000 * 4, reference: REF, metadata: { kind: "subscription", schoolId: SA } },
    };
    await billing.applySubscriptionPayment(event);

    const sub = await subRow(SA);
    expect(sub?.plan).toBe("STANDARD");
    expect(sub?.status).toBe("ACTIVE");
    expect(sub?.currentPeriodEnd).not.toBeNull();
    const pay = await admin.query(`SELECT status FROM platform_subscription_payment WHERE reference = $1`, [REF]);
    expect(pay.rows[0].status).toBe("PAID");

    // Idempotent: replaying the same event does not extend the period again.
    const before = (await subRow(SA))!.currentPeriodEnd;
    await billing.applySubscriptionPayment(event);
    const after = (await subRow(SA))!.currentPeriodEnd;
    expect(new Date(after!).getTime()).toBe(new Date(before!).getTime());
  });

  it("dunning flips an elapsed ACTIVE subscription PAST_DUE; entitlements drop to BASIC", async () => {
    // Back-date the period end beyond the grace window, re-arm as ACTIVE.
    await admin.query(
      `UPDATE school_subscription
         SET status = 'ACTIVE', "currentPeriodEnd" = now() - interval '20 days'
       WHERE "schoolId" = $1`,
      [SA],
    );
    entitlements.invalidate(SA);

    const result = await billing.runDunning(staff());
    expect(result.pastDue).toBeGreaterThanOrEqual(1);

    const sub = await subRow(SA);
    expect(sub?.status).toBe("PAST_DUE");
    expect(sub?.plan).toBe("STANDARD"); // purchased plan is preserved

    // Effective entitlement is BASIC: LMS stays, FEES (a STANDARD module) is gone.
    expect(await entitlements.isEnabled(SA, MODULES.LMS)).toBe(true);
    expect(await entitlements.isEnabled(SA, MODULES.FEES)).toBe(false);
  });
});
