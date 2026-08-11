// =============================================================================
// Settlement + verify-on-return + reconciliation — lost-webhook recovery (real DB)
// =============================================================================
// The webhook used to be the ONLY path that posted an online payment: a lost
// delivery meant a charged card and a forever-unpaid invoice. This proves the
// three recovery layers against real RLS:
//   - InvoiceSettlementService posts idempotently on the gateway reference
//     (webhook / verify / reconcile can all race safely)
//   - confirmInvoicePayment (payer's return) posts a gateway-verified charge,
//     and refuses metadata that doesn't match the invoice+school
//   - the reconciliation sweep finds a settled gateway charge with no ledger
//     payment, posts it, and alerts the owner that webhooks are unhealthy
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import { PaymentGatewayService } from "../../src/fees/payment-gateway.service";
import { PaymentReconciliationService } from "../../src/fees/reconciliation.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("Online settlement, verify-on-return and reconciliation (real Postgres)", () => {
  let admin: Pool;
  let settlement: InvoiceSettlementService;
  let notifications: NotificationService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const PARENT = randomUUID();
  const STUDENT = randomUUID();
  const invoiceId = randomUUID();

  const parent = (): Principal => ({ userId: PARENT, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });

  const meta = (over: Record<string, unknown> = {}) => ({
    kind: "invoice",
    invoiceId,
    schoolId: SA,
    payerId: PARENT,
    invoiceAmountMinor: 40_000,
    platformFeeMinor: 0,
    ...over,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RC',$2,now())`, [SA, "rec-" + SA]);
    for (const [u, name] of [[STAFF, "Staff"], [PARENT, "Parent"], [STUDENT, "Student"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@rec", name],
      );
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      PARENT,
      STUDENT,
    ]);
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-REC-1','ISSUED',40000,now(),$4,now())`,
      [invoiceId, SA, STUDENT, STAFF],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    notifications = new NotificationService(tenant, audit, queue as never);
    settlement = new InvoiceSettlementService(tenant, audit, notifications);
  });

  afterAll(async () => {
    for (const t of ["gateway_event", "payment", "invoice", "notification_delivery", "notification", "audit_log", "parent_child"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("applyOnlinePayment posts once and is idempotent on the reference", async () => {
    const first = await settlement.applyOnlinePayment({
      schoolId: SA,
      invoiceId,
      creditMinor: 15_000,
      chargedMinor: 15_000,
      currency: "NGN",
      reference: "REC-REF-1",
      payerId: PARENT,
      note: "Online (Paystack)",
    });
    expect(first).toBe("posted");
    const dup = await settlement.applyOnlinePayment({
      schoolId: SA,
      invoiceId,
      creditMinor: 15_000,
      chargedMinor: 15_000,
      currency: "NGN",
      reference: "REC-REF-1",
      payerId: PARENT,
      note: "Online (Paystack)",
    });
    expect(dup).toBe("duplicate");
    const pays = await admin.query(`SELECT status FROM payment WHERE "invoiceId" = $1`, [invoiceId]);
    expect(pays.rowCount).toBe(1);
    const inv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [invoiceId]);
    expect((inv.rows[0] as { status: string }).status).toBe("PARTIALLY_PAID");
  });

  it("verify-on-return posts a gateway-confirmed charge the webhook missed; mismatched metadata is refused", async () => {
    const paystack = {
      isConfigured: () => true,
      verifyTransaction: jest.fn().mockResolvedValue({ status: "success", amountMinor: 25_000, currency: "NGN", metadata: meta({ invoiceAmountMinor: 25_000 }) }),
    };
    const tenant = new PrismaTenantService() as never;
    const gateway = new PaymentGatewayService(
      tenant,
      new AuditLogService(),
      paystack as never,
      {} as never, // billing (unused here)
      { client: null } as never,
      notifications,
      {} as never, // platform fees (unused)
      {} as never, // admissions (unused)
      {} as never, // message credits (unused)
      {} as never, // disputes (unused)
      { record: jest.fn() } as never, // gateway events
      settlement,
      {} as never, // virtual accounts (unused here)
      {} as never, // payment plans (unused here)
      { isConfigured: () => false } as never, // stripe (NGN invoice in this test)
    );

    const ok = await gateway.confirmInvoicePayment(parent(), invoiceId, "REC-REF-2");
    expect(ok.status).toBe("posted");
    // Re-confirming the same reference reports already_recorded, never double-posts.
    const again = await gateway.confirmInvoicePayment(parent(), invoiceId, "REC-REF-2");
    expect(again.status).toBe("already_recorded");
    // Invoice is now fully paid (15k + 25k = 40k).
    const inv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [invoiceId]);
    expect((inv.rows[0] as { status: string }).status).toBe("PAID");

    // A charge whose metadata points at a DIFFERENT school/invoice never posts.
    paystack.verifyTransaction.mockResolvedValue({
      status: "success",
      amountMinor: 25_000,
      currency: "NGN",
      metadata: meta({ schoolId: randomUUID() }),
    });
    const refused = await gateway.confirmInvoicePayment(parent(), invoiceId, "REC-REF-EVIL");
    expect(refused.status).toBe("not_settled");
  });

  it("a USD invoice routes checkout to STRIPE with kind=invoice metadata (Paystack rail untouched)", async () => {
    const usdInvoice = randomUUID();
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-REC-USD','ISSUED','USD',80000,now(),$4,now())`,
      [usdInvoice, SA, STUDENT, STAFF],
    );
    const stripeStub = {
      isConfigured: () => true,
      createCheckoutSession: jest.fn().mockResolvedValue({ authorizationUrl: "https://checkout.stripe.com/x" }),
    };
    const tenant = new PrismaTenantService() as never;
    const gateway = new PaymentGatewayService(
      tenant,
      new AuditLogService(),
      { isConfigured: () => false } as never, // Paystack OFF — USD must not need it
      {} as never,
      { client: null } as never,
      notifications,
      { effective: jest.fn().mockResolvedValue({ bearer: "PARENT" }) } as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      settlement,
      {} as never,
      {} as never,
      stripeStub as never,
    );
    const out = await gateway.initInvoicePayment(parent(), usdInvoice);
    expect(out.authorizationUrl).toContain("stripe.com");
    expect(out.chargedMinor).toBe(80_000);
    const call = stripeStub.createCheckoutSession.mock.calls[0][0];
    expect(call.metadata).toMatchObject({ kind: "invoice", invoiceId: usdInvoice, schoolId: SA });
    await admin.query(`DELETE FROM invoice WHERE id = $1`, [usdInvoice]);
  });

  it("verify-on-return posts a USD invoice via STRIPE (settles on the session's client_reference_id)", async () => {
    const usdInvoice = randomUUID();
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-REC-USD2','ISSUED','USD',80000,now(),$4,now())`,
      [usdInvoice, SA, STUDENT, STAFF],
    );
    // The return page passes the SESSION id; we settle on the session's
    // client_reference_id (the same key the webhook uses → idempotent).
    const stripeStub = {
      isConfigured: () => true,
      retrieveCheckoutSession: jest.fn().mockResolvedValue({
        paymentStatus: "paid",
        clientReferenceId: "USD-CONFIRM-1",
        amountTotal: 80_000,
        currency: "USD",
        metadata: { kind: "invoice", invoiceId: usdInvoice, schoolId: SA, payerId: PARENT, invoiceAmountMinor: "80000" },
      }),
    };
    const tenant = new PrismaTenantService() as never;
    const gateway = new PaymentGatewayService(
      tenant, new AuditLogService(), { isConfigured: () => false } as never, {} as never, { client: null } as never,
      notifications, { effective: jest.fn().mockResolvedValue({ bearer: "PARENT" }) } as never,
      {} as never, {} as never, {} as never, { record: jest.fn() } as never, settlement, {} as never, {} as never, stripeStub as never,
    );
    const ok = await gateway.confirmInvoicePayment(parent(), usdInvoice, "cs_test_session_id");
    expect(ok.status).toBe("posted");
    expect(stripeStub.retrieveCheckoutSession).toHaveBeenCalledWith("cs_test_session_id");
    // Posted on the client_reference_id, NOT the session id.
    const posted = await admin.query(`SELECT reference FROM payment WHERE "invoiceId" = $1`, [usdInvoice]);
    expect(posted.rowCount).toBe(1);
    expect((posted.rows[0] as { reference: string }).reference).toBe("USD-CONFIRM-1");
    // Idempotent: a second confirm (webhook could also have fired) posts nothing new.
    const again = await gateway.confirmInvoicePayment(parent(), usdInvoice, "cs_test_session_id");
    expect(again.status).toBe("already_recorded");
    await admin.query(`DELETE FROM payment WHERE "invoiceId" = $1`, [usdInvoice]);
    await admin.query(`DELETE FROM invoice WHERE id = $1`, [usdInvoice]);
  });

  it("the reconciliation sweep posts a settled charge with no ledger payment and alerts the owner", async () => {
    const paystack = {
      isConfigured: () => true,
      listSuccessfulTransactions: jest
        .fn()
        .mockResolvedValue([
          { reference: "REC-REF-1", amountMinor: 15_000, currency: "NGN", metadata: meta() }, // already posted
          { reference: "REC-REF-3", amountMinor: 5_000, currency: "NGN", metadata: meta({ invoiceAmountMinor: 5_000 }) }, // missed
          { reference: "OTHER", amountMinor: 1_000, currency: "NGN", metadata: { kind: "subscription" } }, // not an invoice charge
        ]),
    };
    // Stripe unconfigured here — this case exercises the Paystack pass only.
    const stripe = { isConfigured: () => false, listRecentPaidSessions: jest.fn().mockResolvedValue([]) };
    // Privileged stub: the BATCHED cross-tenant existence check runs against the
    // REAL ledger via the admin pool so both branches (found / missing) are honest.
    const privileged = {
      client: {
        payment: {
          findMany: jest.fn(async (args: { where: { reference: { in: string[] } } }) => {
            const r = await admin.query(`SELECT reference FROM payment WHERE reference = ANY($1)`, [args.where.reference.in]);
            return r.rows.map((row) => ({ reference: (row as { reference: string }).reference }));
          }),
        },
        user: { findMany: jest.fn().mockResolvedValue([{ id: STAFF, schoolId: SA }]) },
      },
    };
    const tenant = new PrismaTenantService() as never;
    const reconcile = new PaymentReconciliationService(
      tenant,
      new AuditLogService(),
      paystack as never,
      stripe as never,
      privileged as never,
      notifications,
      settlement,
      // Subscription recovery is exercised in checkout-intent/billing suites;
      // these cases are about invoice charges, so it is a no-op double.
      { recoverSubscriptionCharge: jest.fn().mockResolvedValue(false) } as never,
      // Credit-bundle recovery is covered in its own suite; a no-op double here.
      { hasEntryForReference: jest.fn().mockResolvedValue(true), applyPurchase: jest.fn() } as never,
    );

    const r = await reconcile.sweep("SCHEDULED");
    expect(r).toMatchObject({ scanned: 3, invoiceCharges: 2, missing: 1, posted: 1 });
    const pays = await admin.query(`SELECT reference FROM payment WHERE "invoiceId" = $1 ORDER BY "createdAt"`, [invoiceId]);
    expect(pays.rowCount).toBe(3);
    const owner = await admin.query(
      `SELECT title FROM notification WHERE "recipientId" = $1 AND title LIKE 'Reconciliation recovered%'`,
      [STAFF],
    );
    expect(owner.rowCount).toBeGreaterThan(0);

    // A second sweep finds nothing missing — fully idempotent.
    const r2 = await reconcile.sweep("SCHEDULED");
    expect(r2).toMatchObject({ missing: 0, posted: 0 });
  });

  it("the sweep ALSO recovers a missed STRIPE (USD) charge — string metadata coerced", async () => {
    // Paystack off, Stripe on: a paid USD checkout session with no ledger payment
    // is recovered exactly like a Paystack one. Stripe metadata is all STRINGS —
    // the amount must still coerce to a number for the credit.
    //
    // The charge settles a USD INVOICE. It used to point at the suite's NGN one,
    // and passed — because nothing compared the two. That is the bug the currency
    // guard exists for, sitting undetected in the test fixture for the sweep whose
    // whole job is recovering money correctly.
    const usdInvoice = randomUUID();
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-REC-USD3','ISSUED','USD',40000,now(),$4,now())`,
      [usdInvoice, SA, STUDENT, STAFF],
    );
    const paystack = { isConfigured: () => false, listSuccessfulTransactions: jest.fn().mockResolvedValue([]) };
    const stripe = {
      isConfigured: () => true,
      listRecentPaidSessions: jest.fn().mockResolvedValue([
        { reference: "STRIPE-REC-1", amountMinor: 40_000, currency: "USD", metadata: { kind: "invoice", invoiceId: usdInvoice, schoolId: SA, payerId: PARENT, invoiceAmountMinor: "40000" } },
      ]),
    };
    const privileged = {
      client: {
        payment: {
          findMany: jest.fn(async (args: { where: { reference: { in: string[] } } }) => {
            const r = await admin.query(`SELECT reference FROM payment WHERE reference = ANY($1)`, [args.where.reference.in]);
            return r.rows.map((row) => ({ reference: (row as { reference: string }).reference }));
          }),
        },
        user: { findMany: jest.fn().mockResolvedValue([{ id: STAFF, schoolId: SA }]) },
      },
    };
    const tenant = new PrismaTenantService() as never;
    const reconcile = new PaymentReconciliationService(
      tenant, new AuditLogService(), paystack as never, stripe as never, privileged as never, notifications, settlement,
      { recoverSubscriptionCharge: jest.fn().mockResolvedValue(false) } as never,
      // Credit-bundle recovery is covered in its own suite; a no-op double here.
      { hasEntryForReference: jest.fn().mockResolvedValue(true), applyPurchase: jest.fn() } as never,
    );
    const r = await reconcile.sweep("SCHEDULED");
    expect(r).toMatchObject({ scanned: 1, invoiceCharges: 1, missing: 1, posted: 1 });
    const posted = await admin.query(`SELECT "amountMinor" FROM payment WHERE reference = $1`, ["STRIPE-REC-1"]);
    expect(posted.rowCount).toBe(1);
    expect((posted.rows[0] as { amountMinor: number }).amountMinor).toBe(40_000); // string "40000" coerced
    // Child rows BEFORE parents — payment references invoice.
    await admin.query(`DELETE FROM payment WHERE "invoiceId" = $1`, [usdInvoice]);
    await admin.query(`DELETE FROM audit_log WHERE "entityId" = $1`, [usdInvoice]);
    await admin.query(`DELETE FROM invoice WHERE id = $1`, [usdInvoice]);
  });

  it("REFUSES to recover a charge whose currency disagrees with the invoice", async () => {
    // The sweep is the LAST line of defence for lost webhooks, so it must not be
    // the place a wrong-currency charge finally sneaks in. It reports the charge
    // as missing (it genuinely is) but posts nothing, leaving the invoice open for
    // a human rather than marking it PAID for a tenth of the money.
    const paystack = {
      isConfigured: () => true,
      listSuccessfulTransactions: jest.fn().mockResolvedValue([
        { reference: "REC-WRONG-CCY", amountMinor: 5_000, currency: "GHS", metadata: meta({ invoiceAmountMinor: 5_000 }) },
      ]),
    };
    const stripe = { isConfigured: () => false, listRecentPaidSessions: jest.fn().mockResolvedValue([]) };
    const privileged = {
      client: {
        payment: { findMany: jest.fn().mockResolvedValue([]) },
        user: { findMany: jest.fn().mockResolvedValue([{ id: STAFF, schoolId: SA }]) },
      },
    };
    const reconcile = new PaymentReconciliationService(
      new PrismaTenantService() as never, new AuditLogService(), paystack as never, stripe as never,
      privileged as never, notifications, settlement,
      { recoverSubscriptionCharge: jest.fn().mockResolvedValue(false) } as never,
      // Credit-bundle recovery is covered in its own suite; a no-op double here.
      { hasEntryForReference: jest.fn().mockResolvedValue(true), applyPurchase: jest.fn() } as never,
    );
    const r = await reconcile.sweep("SCHEDULED");
    expect(r).toMatchObject({ missing: 1, posted: 0 });
    const rows = await admin.query(`SELECT 1 FROM payment WHERE reference = $1`, ["REC-WRONG-CCY"]);
    expect(rows.rowCount).toBe(0);
  });
});
