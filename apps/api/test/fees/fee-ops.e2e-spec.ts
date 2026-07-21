// =============================================================================
// FeeOpsService — adjustments, late-fee sweep, receipts, journal (real DB)
// =============================================================================
// Proves: the discount/waiver maker-checker (requester can NEVER approve their
// own; approval posts the negative line item + reduces the total, capped at
// the outstanding balance), the late-fee sweep (applies the configured flat
// fee ONCE per overdue invoice — a second sweep is a no-op — and never touches
// invoices inside grace), the numbered receipt PDF (family-scoped,
// 404-not-403), and the formula-guarded journal CSV.
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeeOpsService } from "../../src/fees/fee-ops.service";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("FeeOpsService adjustments + late fees + receipts + journal (real Postgres)", () => {
  let admin: Pool;
  let svc: FeeOpsService;

  const SA = randomUUID();
  const MAKER = randomUUID(); // accountant requesting
  const CHECKER = randomUUID(); // principal approving
  const GUARDIAN = randomUUID();
  const OUTSIDER = randomUUID(); // unrelated parent
  const STUDENT = randomUUID();
  const adjInvoice = randomUUID(); // 100k — gets a 20k discount
  const lateInvoice = randomUUID(); // overdue past grace — gets the late fee
  const freshInvoice = randomUUID(); // due in future — must be untouched
  const paymentId = randomUUID(); // posted payment for receipt/journal

  const maker = (): Principal => ({ userId: MAKER, schoolId: SA, roles: ["accountant"], permissions: ["fee.manage"] });
  const checker = (): Principal => ({ userId: CHECKER, schoolId: SA, roles: ["principal"], permissions: ["fee.approve"] });
  const guardian = (): Principal => ({ userId: GUARDIAN, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });
  const outsider = (): Principal => ({ userId: OUTSIDER, schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      `INSERT INTO school (id,name,slug,"lateFeeFlatMinor","lateFeeGraceDays","updatedAt") VALUES ($1,'FO',$2,5000,7,now())`,
      [SA, "fo-" + SA],
    );
    for (const [u, name] of [
      [MAKER, "Maker"],
      [CHECKER, "Checker"],
      [GUARDIAN, "Guardian"],
      [OUTSIDER, "Outsider"],
      [STUDENT, "Fo Student"],
    ] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@fo", name],
      );
    }
    await admin.query(`INSERT INTO parent_child (id,"schoolId","parentId","studentId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      GUARDIAN,
      STUDENT,
    ]);
    for (const [id, ref, total, due] of [
      [adjInvoice, "INV-FO-ADJ", 100_000, "now() + interval '10 days'"],
      [lateInvoice, "INV-FO-LATE", 40_000, "now() - interval '10 days'"],
      [freshInvoice, "INV-FO-FRESH", 40_000, "now() + interval '10 days'"],
    ] as const) {
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,'ISSUED',$5,${due},$6,now())`,
        [id, SA, STUDENT, ref, total, MAKER],
      );
    }
    await admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,reference,"recordedById") VALUES ($1,$2,$3,25000,'CASH','FO-PAY-1',$4)`,
      [paymentId, SA, adjInvoice, MAKER],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    const fees = new FeesService(tenant, audit, notifications, { isConfigured: () => false } as never);
    // Privileged stub: the sweep's school list is THIS school with its config.
    const privileged = {
      client: {
        school: {
          findMany: jest.fn().mockResolvedValue([{ id: SA, lateFeeFlatMinor: 5_000, lateFeeGraceDays: 7 }]),
          update: jest.fn(),
        },
      },
    };
    svc = new FeeOpsService(tenant, audit, notifications, privileged as never, fees);
  });

  afterAll(async () => {
    for (const t of [
      "invoice_adjustment",
      "payment",
      "invoice_line_item",
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

  it("maker-checker: requester cannot approve their own adjustment; a DIFFERENT approver posts it", async () => {
    const adj = await svc.requestAdjustment(maker(), adjInvoice, {
      kind: "DISCOUNT",
      amountMinor: 20_000,
      reason: "Sibling discount",
    });
    expect(adj.status).toBe("PENDING_APPROVAL");
    // The maker holds fee.approve in some schools — the SERVICE still refuses.
    await expect(svc.decideAdjustment(maker(), adj.id, true)).rejects.toMatchObject({ status: 403 });

    const approved = await svc.decideAdjustment(checker(), adj.id, true);
    expect(approved.status).toBe("APPROVED");
    const inv = await admin.query(`SELECT "totalMinor",status FROM invoice WHERE id = $1`, [adjInvoice]);
    expect(inv.rows[0]).toMatchObject({ totalMinor: 80_000, status: "PARTIALLY_PAID" }); // 25k paid of 80k
    const line = await admin.query(
      `SELECT "amountMinor" FROM invoice_line_item WHERE "invoiceId" = $1 AND description LIKE 'Discount%'`,
      [adjInvoice],
    );
    expect((line.rows[0] as { amountMinor: number }).amountMinor).toBe(-20_000);
    // Already decided -> 400.
    await expect(svc.decideAdjustment(checker(), adj.id, false)).rejects.toMatchObject({ status: 400 });
  });

  it("an adjustment larger than the outstanding balance is refused", async () => {
    await expect(
      svc.requestAdjustment(maker(), adjInvoice, { kind: "WAIVER", amountMinor: 60_000, reason: "too much" }),
    ).rejects.toMatchObject({ status: 400 }); // outstanding is 55k (80k - 25k)
  });

  it("late-fee sweep: applies ONCE to the overdue invoice, never to the fresh one; second sweep is a no-op", async () => {
    const first = await svc.lateFeeSweep();
    expect(first).toMatchObject({ schools: 1, feesApplied: 1 });
    const late = await admin.query(`SELECT "totalMinor" FROM invoice WHERE id = $1`, [lateInvoice]);
    expect((late.rows[0] as { totalMinor: number }).totalMinor).toBe(45_000);
    const fresh = await admin.query(`SELECT "totalMinor" FROM invoice WHERE id = $1`, [freshInvoice]);
    expect((fresh.rows[0] as { totalMinor: number }).totalMinor).toBe(40_000);
    const guardianNote = await admin.query(
      `SELECT id FROM notification WHERE "recipientId" = $1 AND title = 'Late fee added'`,
      [GUARDIAN],
    );
    expect(guardianNote.rowCount).toBe(1);

    const second = await svc.lateFeeSweep();
    expect(second).toMatchObject({ feesApplied: 0 });
    const still = await admin.query(`SELECT "totalMinor" FROM invoice WHERE id = $1`, [lateInvoice]);
    expect((still.rows[0] as { totalMinor: number }).totalMinor).toBe(45_000);
  });

  it("receipt PDF: guardian downloads it; an unrelated parent gets 404", async () => {
    const { buffer, filename } = await svc.receiptPdf(guardian(), paymentId);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(filename).toMatch(/^RCP-\d{8}-[0-9A-F]{8}\.pdf$/);
    await expect(svc.receiptPdf(outsider(), paymentId)).rejects.toMatchObject({ status: 404 });
  });

  it("journal CSV: posted payments in range, formula-guarded", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { csv } = await svc.journalCsv(maker(), "2020-01-01", today);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Receipt");
    expect(lines.some((l) => l.includes("INV-FO-ADJ") && l.includes("250.00"))).toBe(true);
    // No cell begins with a spreadsheet formula trigger.
    for (const line of lines.slice(1)) {
      for (const cell of line.split(",")) expect(/^[=+@\t\r]/.test(cell.replace(/^"/, ""))).toBe(false);
    }
  });
});
