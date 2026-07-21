// =============================================================================
// VirtualAccountsService — dedicated-NUBAN provisioning + transfer credit (real DB)
// =============================================================================
// Proves: staff provisioning stores the gateway account (idempotent — never a
// second NUBAN), reads are self/guardian/staff-scoped 404-not-403, and an
// incoming dedicated-account transfer (charge.success with ONLY a customer
// code) is mapped back to the student and credited to their OLDEST open
// invoice through the shared settlement path; a transfer with no open invoice
// alerts finance instead of guessing.
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { VirtualAccountsService } from "../../src/fees/virtual-accounts.service";
import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import { PaymentPlansService } from "../../src/fees/payment-plans.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("VirtualAccountsService dedicated NUBAN (real Postgres)", () => {
  let admin: Pool;
  let svc: VirtualAccountsService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const GUARDIAN = randomUUID();
  const OTHER_PARENT = randomUUID();
  const STUDENT = randomUUID();
  const oldInvoice = randomUUID(); // due earlier — must be credited first
  const newInvoice = randomUUID();
  const CUS = "CUS_va_" + randomUUID().slice(0, 8);
  const createdRoleId = randomUUID();

  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["school_admin"], permissions: ["fee.manage"] });
  const guardian = (): Principal => ({ userId: GUARDIAN, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });
  const otherParent = (): Principal => ({ userId: OTHER_PARENT, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'VA',$2,now())`, [SA, "va-" + SA]);
    for (const [u, name] of [
      [STAFF, "Staff"],
      [GUARDIAN, "Guardian"],
      [OTHER_PARENT, "Other Parent"],
      [STUDENT, "Va Student"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@va", name],
      );
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      GUARDIAN,
      STUDENT,
    ]);
    // Finance alerts resolve recipients via user_role -> role by NAME.
    const existingRole = await admin.query(`SELECT id FROM role WHERE name = 'school_admin'`);
    const rid = existingRole.rowCount ? (existingRole.rows[0] as { id: string }).id : createdRoleId;
    if (!existingRole.rowCount) await admin.query(`INSERT INTO role (id,name) VALUES ($1,'school_admin')`, [createdRoleId]);
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      STAFF,
      rid,
    ]);
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-VA-OLD','ISSUED',30000,now() - interval '30 days',$4,now())`,
      [oldInvoice, SA, STUDENT, STAFF],
    );
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'INV-VA-NEW','ISSUED',50000,now() + interval '30 days',$4,now())`,
      [newInvoice, SA, STUDENT, STAFF],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    const settlement = new InvoiceSettlementService(tenant, audit, notifications);
    const paystack = {
      isConfigured: () => true,
      createCustomer: jest.fn().mockResolvedValue({ customerCode: CUS }),
      createDedicatedAccount: jest.fn().mockResolvedValue({ accountNumber: "9911223344", bankName: "Wema Bank" }),
    };
    // Privileged stub: the webhook's code->student lookup against the REAL row.
    const privileged = {
      client: {
        studentVirtualAccount: {
          findFirst: jest.fn(async (args: { where: { customerCode: string } }) => {
            const r = await admin.query(
              `SELECT "schoolId","studentId",active FROM student_virtual_account WHERE "customerCode" = $1`,
              [args.where.customerCode],
            );
            return r.rowCount ? r.rows[0] : null;
          }),
        },
      },
    };
    const paymentPlans = new PaymentPlansService(tenant, audit, notifications, paystack as never);
    svc = new VirtualAccountsService(tenant, audit, paystack as never, privileged as never, notifications, settlement, paymentPlans);
  });

  afterAll(async () => {
    for (const t of [
      "student_credit_entry",
      "student_virtual_account",
      "payment",
      "invoice",
      "notification_delivery",
      "notification",
      "audit_log",
      "parent_child",
      "user_role",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM role WHERE id = $1`, [createdRoleId]); // only if this suite created it
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("staff provisions the account once — a second call returns the SAME NUBAN, never a new one", async () => {
    const first = await svc.provision(staff(), STUDENT);
    expect(first).toMatchObject({ studentId: STUDENT, accountNumber: "9911223344", bankName: "Wema Bank", active: true });
    const again = await svc.provision(staff(), STUDENT);
    expect(again.accountNumber).toBe("9911223344");
    const rows = await admin.query(`SELECT id FROM student_virtual_account WHERE "studentId" = $1`, [STUDENT]);
    expect(rows.rowCount).toBe(1);
    // Guardian told the account details.
    const notif = await admin.query(
      `SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Dedicated fee account assigned'`,
      [GUARDIAN],
    );
    expect(notif.rowCount).toBe(1);
  });

  it("guardian can read it; an unrelated parent gets 404-not-403", async () => {
    const mine = await svc.getForStudent(guardian(), STUDENT);
    expect(mine.accountNumber).toBe("9911223344");
    await expect(svc.getForStudent(otherParent(), STUDENT)).rejects.toMatchObject({ status: 404 });
  });

  it("a transfer credits the OLDEST open invoice via the shared settlement path", async () => {
    await svc.applyDedicatedCredit({
      event: "charge.success",
      data: { amount: 30_000, reference: "VA-TRF-1", channel: "dedicated_nuban", customer: { customer_code: CUS } },
    } as never);
    const oldPay = await admin.query(`SELECT method,status FROM payment WHERE "invoiceId" = $1`, [oldInvoice]);
    expect(oldPay.rowCount).toBe(1);
    expect(oldPay.rows[0]).toMatchObject({ method: "BANK_TRANSFER", status: "POSTED" });
    const oldInv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [oldInvoice]);
    expect((oldInv.rows[0] as { status: string }).status).toBe("PAID");
    // The newer invoice is untouched.
    const newPay = await admin.query(`SELECT id FROM payment WHERE "invoiceId" = $1`, [newInvoice]);
    expect(newPay.rowCount).toBe(0);
  });

  it("a transfer with NO open invoice lands on the CREDIT balance (idempotent) and tells finance", async () => {
    // Settle the remaining invoice first.
    await admin.query(`UPDATE invoice SET status = 'PAID' WHERE id = $1`, [newInvoice]);
    const evt = {
      event: "charge.success",
      data: { amount: 10_000, reference: "VA-TRF-2", channel: "dedicated_nuban", customer: { customer_code: CUS } },
    } as never;
    await svc.applyDedicatedCredit(evt);
    await svc.applyDedicatedCredit(evt); // gateway retry — must not double-credit
    const credit = await admin.query(
      `SELECT "deltaMinor",reason FROM student_credit_entry WHERE reference = 'VA-TRF-2'`,
    );
    expect(credit.rowCount).toBe(1);
    expect(credit.rows[0]).toMatchObject({ deltaMinor: 10_000, reason: "PREPAYMENT" });
    const alert = await admin.query(
      `SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Bank transfer added to credit balance'`,
      [STAFF],
    );
    expect(alert.rowCount).toBe(1);
    // And no payment row was invented.
    const pays = await admin.query(`SELECT id FROM payment WHERE reference = 'VA-TRF-2'`);
    expect(pays.rowCount).toBe(0);
  });
});
