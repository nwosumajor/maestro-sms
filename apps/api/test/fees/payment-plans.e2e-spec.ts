// =============================================================================
// PaymentPlansService — installments + credit ledger (real DB)
// =============================================================================
// Proves: plan validation (sum must equal the invoice total), derived tranche
// states from cumulative payments, prepayment webhook credit (idempotent),
// applying credit to an invoice (APPLIED entry + CREDIT payment, atomically),
// and the overpayment double-entry move (system REFUND on the source invoice +
// OVERPAYMENT credit — collections never double-count).
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { PaymentPlansService } from "../../src/fees/payment-plans.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("PaymentPlansService installments + credit (real Postgres)", () => {
  let admin: Pool;
  let svc: PaymentPlansService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const GUARDIAN = randomUUID();
  const STUDENT = randomUUID();
  const planInvoice = randomUUID(); // 90k, 3 tranches
  const overpaidInvoice = randomUUID(); // 20k total, 30k paid
  const targetInvoice = randomUUID(); // 25k — credit applied here

  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["school_admin"], permissions: ["fee.manage"] });
  const guardian = (): Principal => ({ userId: GUARDIAN, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'PP',$2,now())`, [SA, "pp-" + SA]);
    for (const [u, name] of [[STAFF, "Staff"], [GUARDIAN, "Guardian"], [STUDENT, "Pp Student"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@pp", name],
      );
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      GUARDIAN,
      STUDENT,
    ]);
    for (const [id, ref, total, status] of [
      [planInvoice, "INV-PP-PLAN", 90_000, "ISSUED"],
      [overpaidInvoice, "INV-PP-OVER", 20_000, "PAID"],
      [targetInvoice, "INV-PP-TGT", 25_000, "ISSUED"],
    ] as const) {
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,now() + interval '30 days',$7,now())`,
        [id, SA, STUDENT, ref, status, total, STAFF],
      );
    }
    // The overpaid invoice: 30k posted against a 20k bill.
    await admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById") VALUES ($1,$2,$3,30000,'CASH',$4)`,
      [randomUUID(), SA, overpaidInvoice, STAFF],
    );
    // A partial payment on the plan invoice: covers tranche 1 (30k) only.
    await admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById") VALUES ($1,$2,$3,30000,'CASH',$4)`,
      [randomUUID(), SA, planInvoice, STAFF],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new PaymentPlansService(tenant, audit, notifications, { isConfigured: () => true } as never);
  });

  afterAll(async () => {
    for (const t of [
      "student_credit_entry",
      "invoice_installment",
      "payment",
      "invoice",
      "notification_delivery",
      "notification",
      "audit_log",
      "parent_child",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("rejects a plan whose tranches don't sum to the invoice total", async () => {
    await expect(
      svc.setPlan(staff(), planInvoice, [
        { dueDate: "2026-08-01", amountMinor: 10_000 },
        { dueDate: "2026-09-01", amountMinor: 10_000 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("sets a plan and derives tranche states from cumulative payments", async () => {
    // 30k already paid -> tranche 1 (30k, past due date) is PAID, tranche 2
    // (overdue date, unpaid) is OVERDUE, tranche 3 (future) is UPCOMING.
    const plan = await svc.setPlan(staff(), planInvoice, [
      { dueDate: "2026-06-01", amountMinor: 30_000 },
      { dueDate: "2026-07-01", amountMinor: 30_000 },
      { dueDate: "2026-12-01", amountMinor: 30_000 },
    ]);
    expect(plan.tranches.map((t) => t.state)).toEqual(["PAID", "OVERDUE", "UPCOMING"]);
    // The guardian sees the same plan (scoped read), an outsider would 404.
    const seen = await svc.getPlan(guardian(), planInvoice);
    expect(seen.tranches).toHaveLength(3);
  });

  it("prepayment webhook credits the ledger idempotently", async () => {
    const evt = {
      event: "charge.success",
      data: {
        amount: 40_000,
        reference: "PP-PRE-1",
        metadata: { kind: "prepay", schoolId: SA, studentId: STUDENT, payerId: GUARDIAN },
      },
    } as never;
    await svc.applyPrepayment(evt);
    await svc.applyPrepayment(evt); // retry — must not double-credit
    const bal = await svc.creditBalance(guardian(), STUDENT);
    expect(bal.balanceMinor).toBe(40_000);
    expect(bal.entries).toHaveLength(1);
  });

  it("applies credit to an invoice: APPLIED entry + CREDIT payment, invoice PAID", async () => {
    const { appliedMinor } = await svc.applyCreditToInvoice(staff(), targetInvoice);
    expect(appliedMinor).toBe(25_000); // min(invoice balance 25k, credit 40k)
    const bal = await svc.creditBalance(staff(), STUDENT);
    expect(bal.balanceMinor).toBe(15_000);
    const pay = await admin.query(`SELECT kind,status FROM payment WHERE "invoiceId" = $1`, [targetInvoice]);
    expect(pay.rows[0]).toMatchObject({ kind: "CREDIT", status: "POSTED" });
    const inv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [targetInvoice]);
    expect((inv.rows[0] as { status: string }).status).toBe("PAID");
    // Nothing left to apply -> 400.
    await expect(svc.applyCreditToInvoice(staff(), targetInvoice)).rejects.toMatchObject({ status: 400 });
  });

  it("moves an overpayment to credit as a double-entry (system REFUND + OVERPAYMENT entry)", async () => {
    const { movedMinor } = await svc.moveOverpaymentToCredit(staff(), overpaidInvoice);
    expect(movedMinor).toBe(10_000);
    const refund = await admin.query(
      `SELECT kind,status,"amountMinor" FROM payment WHERE "invoiceId" = $1 AND kind = 'REFUND'`,
      [overpaidInvoice],
    );
    expect(refund.rows[0]).toMatchObject({ kind: "REFUND", status: "POSTED", amountMinor: 10_000 });
    const bal = await svc.creditBalance(staff(), STUDENT);
    expect(bal.balanceMinor).toBe(25_000); // 15k remaining + 10k moved
    // Not overpaid any more -> a second move is refused.
    await expect(svc.moveOverpaymentToCredit(staff(), overpaidInvoice)).rejects.toMatchObject({ status: 400 });
  });
});
