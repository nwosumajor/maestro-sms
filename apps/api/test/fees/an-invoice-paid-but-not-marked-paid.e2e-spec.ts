// =============================================================================
// PROBE: a staff approval and an online settlement landing at the same moment
// =============================================================================
// Both paths POST a payment and then recompute the invoice's status from the
// posted total. `fees.service` takes `SELECT ... FOR UPDATE` on the invoice
// before doing so — in `recordPayment` AND in `approvePayment`. `settlement
// .service`, which every gateway rail funnels through, does NOT.
//
// So the two can interleave: each reads the posted total BEFORE the other's
// insert, each computes a status from its own stale view, and the last write
// wins. The failure is not a lost payment — both rows land — it is an invoice
// that is fully paid and not marked PAID.
//
// That is not cosmetic. An invoice left ISSUED/PARTIALLY_PAID is chased by the
// overdue reminder sweep, accrues late fees, counts in receivables, and can
// withhold a leaver's documents — for a family that has paid in full.
//
// Run: `pnpm --filter @sms/api test:db -- an-invoice-paid-but-not-marked-paid`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeesService } from "../../src/fees/fees.service";
import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("an invoice paid from two paths at once (real Postgres)", () => {
  let admin: Pool;
  let fees: FeesService;
  let settlement: InvoiceSettlementService;

  const SA = randomUUID();
  const RECORDER = randomUUID();
  const APPROVER = randomUUID();
  const STUDENT = randomUUID();
  const INVOICE = randomUUID();
  const PENDING = randomUUID();
  const HALF = 5_000_000;

  const approver = (): Principal => ({ userId: APPROVER, schoolId: SA, roles: ["principal"], permissions: ["fee.approve"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'PP',$2,'NGN',now())`, [SA, "pp-" + SA]);
    for (const [id, n] of [[RECORDER, "Bursar"], [APPROVER, "Head"], [STUDENT, "Pupil"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SA, `${id}@pp.test`, n],
      );
    }
    // A 10,000,000 invoice: half awaiting approval, half about to settle online.
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor",currency,status,"dueDate","issuedAt","createdById","updatedAt")
       VALUES ($1,$2,$3,'PP-INV',$4,'NGN','ISSUED',now()+interval '30 days',now(),$5,now())`,
      [INVOICE, SA, STUDENT, HALF * 2, RECORDER],
    );
    await admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,kind,status,"recordedById","createdAt")
       VALUES ($1,$2,$3,$4,'CASH','PAYMENT','PENDING_APPROVAL',$5,now())`,
      [PENDING, SA, INVOICE, HALF, RECORDER],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    const region = new SchoolRegionService(tenant);
    fees = new FeesService(tenant, audit, notifications, { isConfigured: () => false } as never, region);
    settlement = new InvoiceSettlementService(
      tenant, audit, notifications,
      { isActive: jest.fn().mockResolvedValue(true) } as never,
    );
  });

  afterAll(async () => {
    for (const t of ["payment", "invoice_line_item", "invoice", "notification_delivery", "notification", "audit_log", "\"user\"", "school"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SA]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("is marked PAID when the approval and the settlement land together", async () => {
    // Promise.all: one staff member approving the queued half at the very
    // moment the gateway settles the other half. Sequentially this is correct.
    await Promise.allSettled([
      fees.approvePayment(approver(), PENDING),
      settlement.applyOnlinePayment({
        schoolId: SA,
        invoiceId: INVOICE,
        reference: `PP-ONLINE-${randomUUID()}`,
        creditMinor: HALF,
        chargedMinor: HALF,
        currency: "NGN",
        payerId: STUDENT,
        method: "CARD",
      } as never),
    ]);

    const rows = await admin.query(
      `SELECT COALESCE(sum("amountMinor"),0)::int AS posted FROM payment WHERE "invoiceId"=$1 AND status='POSTED'`,
      [INVOICE],
    );
    const inv = await admin.query(`SELECT status FROM invoice WHERE id=$1`, [INVOICE]);

    // Both halves really did post — this is not about a lost payment.
    expect(rows.rows[0].posted).toBe(HALF * 2);
    // And the invoice must say so. Left PARTIALLY_PAID, this family is chased by
    // the overdue sweep, charged late fees, and counted in receivables.
    expect(inv.rows[0].status).toBe("PAID");
  });

  it("is marked PAID when TWO ONLINE payments settle together", async () => {
    // Neither settlement path takes the invoice lock — the previous case was
    // protected by `approvePayment`'s. Two gateway payments landing on one
    // invoice (a card charge and a mobile-money transfer; or the reconciliation
    // sweep posting a missed charge while a webhook delivers another) have no
    // lock between them at all.
    const INV2 = randomUUID();
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor",currency,status,"dueDate","issuedAt","createdById","updatedAt")
       VALUES ($1,$2,$3,'PP-INV-2',$4,'NGN','ISSUED',now()+interval '30 days',now(),$5,now())`,
      [INV2, SA, STUDENT, HALF * 2, RECORDER],
    );
    const settle = (ref: string) =>
      settlement.applyOnlinePayment({
        schoolId: SA, invoiceId: INV2, reference: ref,
        creditMinor: HALF, chargedMinor: HALF, currency: "NGN",
        payerId: STUDENT, method: "CARD",
      } as never);

    await Promise.allSettled([settle(`PP-A-${randomUUID()}`), settle(`PP-B-${randomUUID()}`)]);

    const rows = await admin.query(
      `SELECT COALESCE(sum("amountMinor"),0)::int AS posted FROM payment WHERE "invoiceId"=$1 AND status='POSTED'`,
      [INV2],
    );
    const inv = await admin.query(`SELECT status FROM invoice WHERE id=$1`, [INV2]);
    expect(rows.rows[0].posted).toBe(HALF * 2);
    expect(inv.rows[0].status).toBe("PAID");
  });
});
