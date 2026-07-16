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
import { MODULES, computeSubscriptionPriceMinor } from "@sms/types";
import { BillingService } from "../../src/billing/billing.service";
import { BillingDunningService } from "../../src/billing/billing-dunning.service";
import { ModuleEntitlementService } from "../../src/foundation/module-entitlement.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { PaystackService, type PaystackEvent } from "../../src/payments/paystack.service";
import { StripeService } from "../../src/payments/stripe.service";
import { PlanPricingService } from "../../src/billing/plan-pricing.service";
import { ReferralService } from "../../src/billing/referral.service";
import { GrowthService } from "../../src/billing/growth.service";
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
      `SELECT plan,status,"currentPeriodEnd","referralRewardAt" FROM school_subscription WHERE "schoolId" = $1`,
      [schoolId],
    );
    return r.rows[0] as
      | { plan: string; status: string; currentPeriodEnd: Date | null; referralRewardAt: Date | null }
      | undefined;
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
      new PaystackService(),
      new PlanPricingService(tenant, new AuditLogService() as never, { client: privileged } as never),
    );
    const planPricing = new PlanPricingService(
      tenant,
      new AuditLogService() as never,
      { client: privileged } as never,
    );
    billing = new BillingService(
      tenant,
      new AuditLogService() as never,
      entitlements,
      notifications,
      new PaystackService(),
      new StripeService(),
      dunning,
      planPricing,
      new ReferralService(tenant, new AuditLogService() as never),
      new GrowthService(tenant, new AuditLogService() as never, { client: privileged } as never),
    );
  });

  afterAll(async () => {
    for (const t of [
      "school_referral_conversion",
      "school_referral_code",
      "platform_subscription_payment",
      "school_subscription",
      "audit_log",
      "notification",
    ]) {
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
      [randomUUID(), SA, computeSubscriptionPriceMinor("STANDARD", 400, "TERM"), REF, UA],
    );

    const event: PaystackEvent = {
      event: "charge.success",
      data: {
        amount: computeSubscriptionPriceMinor("STANDARD", 400, "TERM"),
        reference: REF,
        metadata: { kind: "subscription", schoolId: SA },
      },
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

  it("a mismatched settlement NEVER activates: underpaid or wrong-currency → FAILED + audited", async () => {
    const expected = computeSubscriptionPriceMinor("STANDARD", 400, "TERM");
    const REF_UNDER = `SUB-under-${randomUUID().slice(0, 8)}`;
    const REF_CCY = `SUB-ccy-${randomUUID().slice(0, 8)}`;
    for (const ref of [REF_UNDER, REF_CCY]) {
      await admin.query(
        `INSERT INTO platform_subscription_payment
           (id,"schoolId",plan,"billingCycle",seats,"amountMinor",reference,status,"initiatedById","updatedAt")
         VALUES ($1,$2,'STANDARD','TERM',400,$3,$4,'PENDING',$5,now())`,
        [randomUUID(), SA, expected, ref, UA],
      );
    }
    const periodBefore = (await subRow(SA))?.currentPeriodEnd ?? null;

    // Underpaid: gateway reports LESS than the quoted charge.
    await billing.applySubscriptionPayment({
      event: "charge.success",
      data: { amount: expected - 1, reference: REF_UNDER, metadata: { kind: "subscription", schoolId: SA } },
    });
    // Wrong currency: right amount, different settlement currency.
    await billing.applySubscriptionPayment({
      event: "charge.success",
      data: { amount: expected, currency: "USD", reference: REF_CCY, metadata: { kind: "subscription", schoolId: SA } },
    });

    for (const ref of [REF_UNDER, REF_CCY]) {
      const pay = await admin.query(`SELECT status FROM platform_subscription_payment WHERE reference = $1`, [ref]);
      expect(pay.rows[0].status).toBe("FAILED");
    }
    // The subscription period never moved.
    const periodAfter = (await subRow(SA))?.currentPeriodEnd ?? null;
    expect(String(periodAfter)).toBe(String(periodBefore));
    // And the refusal is audited.
    const audits = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE "schoolId" = $1 AND action = 'billing.subscription.payment.mismatch'`,
      [SA],
    );
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(2);
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

  it("a referred school's FIRST paid subscription rewards BOTH sides one free term — once", async () => {
    const dayMs = 24 * 3600 * 1000;
    const priceMinor = computeSubscriptionPriceMinor("STANDARD", 400, "TERM");
    const pay = async (ref: string) => {
      await admin.query(
        `INSERT INTO platform_subscription_payment
           (id,"schoolId",plan,"billingCycle",seats,"amountMinor",reference,status,"initiatedById","updatedAt")
         VALUES ($1,$2,'STANDARD','TERM',400,$3,$4,'PENDING',$5,now())`,
        [randomUUID(), SA, priceMinor, ref, UA],
      );
      await billing.applySubscriptionPayment({
        event: "charge.success",
        data: { amount: priceMinor, reference: ref, metadata: { kind: "subscription", schoolId: SA } },
      });
    };

    // School B referred school A: B owns a code; A's subscription is stamped.
    await admin.query(
      `INSERT INTO school_referral_code (id,"schoolId",code,"createdById","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [randomUUID(), SB, `BILLB-${randomUUID().slice(0, 4).toUpperCase()}`, UA],
    );
    await admin.query(`UPDATE school_subscription SET "referredBySchoolId" = $1 WHERE "schoolId" = $2`, [SB, SA]);

    await pay(`SUB-ref1-${randomUUID().slice(0, 8)}`);

    // The payer got the paid TERM (3 mo) PLUS the referral bonus term (3 mo).
    const subA = (await subRow(SA))!;
    expect(subA.referralRewardAt).not.toBeNull();
    const paidGain = new Date(subA.currentPeriodEnd!).getTime() - Date.now();
    expect(paidGain).toBeGreaterThan(170 * dayMs); // ~6 months, not just the paid 3

    // The REFERRER's subscription was created/extended ~one term and a
    // conversion ledger row records it.
    const subB = (await subRow(SB))!;
    expect(new Date(subB.currentPeriodEnd!).getTime() - Date.now()).toBeGreaterThan(80 * dayMs);
    const conv = await admin.query(
      `SELECT "referredSchoolId","rewardMonths" FROM school_referral_conversion WHERE "schoolId" = $1`,
      [SB],
    );
    expect(conv.rows).toHaveLength(1);
    expect(conv.rows[0].referredSchoolId).toBe(SA);

    // A SECOND payment renews normally but grants NO second reward.
    const endB = subB.currentPeriodEnd!;
    await pay(`SUB-ref2-${randomUUID().slice(0, 8)}`);
    const convAfter = await admin.query(`SELECT count(*)::int AS n FROM school_referral_conversion WHERE "schoolId" = $1`, [SB]);
    expect(convAfter.rows[0].n).toBe(1);
    expect(new Date((await subRow(SB))!.currentPeriodEnd!).getTime()).toBe(new Date(endB).getTime());
  });
});
