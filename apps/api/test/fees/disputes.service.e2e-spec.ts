// =============================================================================
// DisputesService — gateway chargeback ingestion + tracking (real DB)
// =============================================================================
// Proves the webhook-driven dispute lifecycle end to end against real RLS:
//   - charge.dispute.create -> an OPEN payment_dispute row linked to the
//     disputed payment/invoice, finance staff notified, audit written
//   - a RETRIED create never duplicates (gatewayDisputeId idempotency)
//   - respond() moves OPEN -> RESPONDED (and only from OPEN)
//   - charge.dispute.resolve maps "declined" -> WON, everything else -> LOST
//   - the THRESHOLD escalation raises an OPERATOR_ALERT once the school hits
//     DISPUTE_ALERT_THRESHOLD disputes inside the window
//   - cross-tenant reads 404 (another school's staff never sees the dispute)
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { DISPUTE_ALERT_THRESHOLD } from "@sms/types";
import { DisputesService } from "../../src/fees/disputes.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import type { PaystackEvent } from "../../src/payments/paystack.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("DisputesService chargeback lifecycle (real Postgres)", () => {
  let admin: Pool;
  let svc: DisputesService;
  let notifications: NotificationService;

  const SA = randomUUID();
  const SB = randomUUID(); // the OTHER school — must never see SA's disputes
  const STAFF = randomUUID(); // school_admin in SA (finance recipient + webhook audit actor)
  const STAFF_B = randomUUID(); // school_admin in SB
  const roleId = randomUUID();
  const invoiceId = randomUUID();
  const paymentId = randomUUID();
  const REF = `PAY-${randomUUID().slice(0, 8)}`;

  const staffA = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["school_admin"], permissions: ["fee.manage"] });
  const staffB = (): Principal => ({ userId: STAFF_B, schoolId: SB, roles: ["school_admin"], permissions: ["fee.manage"] });

  const disputeEvent = (over: {
    event: string;
    disputeId: string;
    reference?: string;
    resolution?: string | null;
  }): PaystackEvent => ({
    event: over.event,
    data: {
      id: over.disputeId,
      amount: 50_000,
      currency: "NGN",
      reference: "",
      status: "awaiting-merchant-feedback",
      category: "chargeback",
      due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      resolution: over.resolution ?? null,
      transaction: { reference: over.reference ?? REF, amount: 50_000, metadata: { schoolId: SA } },
    },
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    for (const [id, name] of [[SA, "Dispute A"], [SB, "Dispute B"]] as const) {
      await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,$2,$3,now())`, [id, name, "dp-" + id]);
    }
    for (const [u, sch] of [[STAFF, SA], [STAFF_B, SB]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'Staff','x',now())`,
        [u, sch, u + "@dp"],
      );
    }
    // The finance-recipient query joins user_role -> role by NAME; reuse the
    // seeded school_admin role when present, else create one.
    const existing = await admin.query(`SELECT id FROM role WHERE name = 'school_admin'`);
    const rid = existing.rowCount ? (existing.rows[0] as { id: string }).id : roleId;
    if (!existing.rowCount) {
      await admin.query(`INSERT INTO role (id,name) VALUES ($1,'school_admin')`, [roleId]);
    }
    for (const [u, sch] of [[STAFF, SA], [STAFF_B, SB]] as const) {
      await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [
        randomUUID(),
        sch,
        u,
        rid,
      ]);
    }
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-DP-1','PAID',50000,now(),$3,now())`,
      [invoiceId, SA, STAFF],
    );
    await admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,reference,"recordedById")
       VALUES ($1,$2,$3,50000,'CARD',$4,$5)`,
      [paymentId, SA, invoiceId, REF, STAFF],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    notifications = new NotificationService(tenant, audit, queue as never);
    // Privileged client unset: the operator escalation is exercised separately
    // with a stub below; everything else must work without it. Stripe stub:
    // the Paystack path never calls getCharge.
    const stripeStub = { getCharge: jest.fn().mockResolvedValue(null) };
    svc = new DisputesService(tenant, audit, notifications, { client: null } as never, stripeStub as never);
  });

  afterAll(async () => {
    for (const t of ["payment_dispute", "notification_delivery", "notification", "audit_log", "payment", "invoice", "user_role"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, [[SA, SB]]);
    await admin.query(`DELETE FROM role WHERE id = $1`, [roleId]); // only if this suite created it
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, [[SA, SB]]);
    await admin.end();
    await prisma.$disconnect();
  });

  const D1 = "disp-" + randomUUID();

  it("charge.dispute.create -> OPEN row linked to the payment, finance notified, audited", async () => {
    await svc.applyDisputeEvent(disputeEvent({ event: "charge.dispute.create", disputeId: D1 }));

    const list = await svc.list(staffA());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      gatewayDisputeId: D1,
      transactionReference: REF,
      paymentId,
      invoiceId,
      status: "OPEN",
      amountMinor: 50_000,
    });
    expect(list[0].dueAt).not.toBeNull();

    const notif = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND type = 'BILLING'`,
      [STAFF],
    );
    expect(notif.rowCount).toBeGreaterThan(0);
    expect((notif.rows[0] as { title: string }).title).toContain("dispute opened");

    const auditRow = await admin.query(
      `SELECT id FROM audit_log WHERE "schoolId" = $1 AND action = 'fee.dispute.opened'`,
      [SA],
    );
    expect(auditRow.rowCount).toBe(1);
  });

  it("a retried create never duplicates (gatewayDisputeId idempotency)", async () => {
    await svc.applyDisputeEvent(disputeEvent({ event: "charge.dispute.create", disputeId: D1 }));
    expect(await svc.list(staffA())).toHaveLength(1);
  });

  it("cross-tenant: the other school's staff sees nothing and gets 404 by id", async () => {
    expect(await svc.list(staffB())).toHaveLength(0);
    const [mine] = await svc.list(staffA());
    await expect(svc.get(staffB(), mine.id)).rejects.toMatchObject({ status: 404 });
  });

  it("respond() moves OPEN -> RESPONDED with the note, and only from OPEN", async () => {
    const [mine] = await svc.list(staffA());
    const updated = await svc.respond(staffA(), mine.id, "Receipt + enrollment record uploaded to Paystack");
    expect(updated.status).toBe("RESPONDED");
    expect(updated.responseNote).toContain("Receipt");
    await expect(svc.respond(staffA(), mine.id, "again")).rejects.toMatchObject({ status: 400 });
  });

  it('charge.dispute.resolve: "declined" -> WON; merchant-accepted -> LOST', async () => {
    await svc.applyDisputeEvent(
      disputeEvent({ event: "charge.dispute.resolve", disputeId: D1, resolution: "declined" }),
    );
    const won = (await svc.list(staffA())).find((x) => x.gatewayDisputeId === D1);
    expect(won).toMatchObject({ status: "WON", resolution: "declined" });
    expect(won!.resolvedAt).not.toBeNull();

    // A second dispute that resolves against the school (create never landed —
    // the terminal row is still recorded: history over silence).
    const D2 = "disp-" + randomUUID();
    await svc.applyDisputeEvent(
      disputeEvent({ event: "charge.dispute.resolve", disputeId: D2, resolution: "merchant-accepted" }),
    );
    const lost = (await svc.list(staffA())).find((x) => x.gatewayDisputeId === D2);
    expect(lost).toMatchObject({ status: "LOST", resolution: "merchant-accepted" });

    const notif = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND title LIKE '%LOST%'`,
      [STAFF],
    );
    expect(notif.rowCount).toBeGreaterThan(0);
  });

  it("threshold escalation: an OPERATOR_ALERT fires once the window count reaches the threshold", async () => {
    // Stubbed privileged client: the platform "owner" is STAFF in SA (a real
    // user row, so the notification FK holds).
    const privileged = {
      client: {
        school: { findFirst: jest.fn().mockResolvedValue({ name: "Dispute A" }) },
        user: { findMany: jest.fn().mockResolvedValue([{ id: STAFF, schoolId: SA }]) },
      },
    };
    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const stripeStub = { getCharge: jest.fn().mockResolvedValue(null) };
    const escalating = new DisputesService(tenant, audit, notifications, privileged as never, stripeStub as never);

    // Already 2 dispute rows exist (D1 + the LOST one); pushing to the
    // threshold must escalate.
    for (let i = (await escalating.list(staffA())).length; i < DISPUTE_ALERT_THRESHOLD; i++) {
      await escalating.applyDisputeEvent(
        disputeEvent({ event: "charge.dispute.create", disputeId: "disp-" + randomUUID() }),
      );
    }
    const alert = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND type = 'OPERATOR_ALERT'`,
      [STAFF],
    );
    expect(alert.rowCount).toBeGreaterThan(0);
    expect((alert.rows[0] as { title: string }).title).toContain("Chargeback alert");
  });

  it("STRIPE: a subscription-charge dispute resolves the school from the fetched charge metadata, alerts the owner immediately, and closed:won -> WON", async () => {
    const DP = "dp_" + randomUUID().slice(0, 8);
    // The dispute event carries only the charge id; the charge's metadata
    // (stamped onto the PaymentIntent at checkout) identifies the school.
    const stripeStub = {
      getCharge: jest.fn().mockResolvedValue({
        metadata: { schoolId: SA, kind: "subscription", reference: "SUB-REF-1" },
        amount: 9_900,
        currency: "usd",
      }),
    };
    const privileged = {
      client: {
        school: { findFirst: jest.fn().mockResolvedValue({ name: "Dispute A" }) },
        user: { findMany: jest.fn().mockResolvedValue([{ id: STAFF, schoolId: SA }]) },
      },
    };
    const tenant = new PrismaTenantService() as never;
    const stripeSvc = new DisputesService(tenant, new AuditLogService(), notifications, privileged as never, stripeStub as never);

    await stripeSvc.applyStripeDisputeEvent({
      type: "charge.dispute.created",
      data: {
        object: {
          id: DP,
          amount: 9_900,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          charge: "ch_test_1",
          evidence_details: { due_by: Math.floor(Date.now() / 1000) + 5 * 86_400 },
        },
      },
    } as never);

    const row = (await stripeSvc.list(staffA())).find((x) => x.gatewayDisputeId === DP);
    expect(row).toMatchObject({
      status: "OPEN",
      currency: "USD",
      amountMinor: 9_900,
      category: "fraudulent",
      transactionReference: "SUB-REF-1",
    });
    expect(stripeStub.getCharge).toHaveBeenCalledWith("ch_test_1");

    // Platform revenue: the owner is alerted on OPEN, not just at the threshold.
    const ownerAlert = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND title LIKE 'Subscription payment disputed%'`,
      [STAFF],
    );
    expect(ownerAlert.rowCount).toBeGreaterThan(0);

    await stripeSvc.applyStripeDisputeEvent({
      type: "charge.dispute.closed",
      data: { object: { id: DP, amount: 9_900, currency: "usd", status: "won", charge: "ch_test_1" } },
    } as never);
    const closed = (await stripeSvc.list(staffA())).find((x) => x.gatewayDisputeId === DP);
    expect(closed).toMatchObject({ status: "WON", resolution: "won" });
  });

  it("STRIPE: an unmappable dispute (no schoolId metadata) is dropped, never guessed", async () => {
    const stripeStub = { getCharge: jest.fn().mockResolvedValue({ metadata: {} }) };
    const tenant = new PrismaTenantService() as never;
    const dropSvc = new DisputesService(tenant, new AuditLogService(), notifications, { client: null } as never, stripeStub as never);
    const before = (await dropSvc.list(staffA())).length;
    const res = await dropSvc.applyStripeDisputeEvent({
      type: "charge.dispute.created",
      data: { object: { id: "dp_unmapped", amount: 100, currency: "usd", charge: "ch_unknown" } },
    } as never);
    expect(res).toEqual({ ok: true });
    expect((await dropSvc.list(staffA())).length).toBe(before);
  });
});
