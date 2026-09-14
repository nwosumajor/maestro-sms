// =============================================================================
// PROBE: two adjustments approved at once — does the cap still hold?
// =============================================================================
// `decideAdjustment` caps a discount at what is outstanding:
//
//     if (row.amountMinor > inv.totalMinor - paid) throw "exceeds the outstanding balance"
//     ...
//     invoice.update({ totalMinor: { decrement: row.amountMinor } })
//
// The DECREMENT is already race-safe, and its comment says so: two different
// adjustments on one invoice would otherwise both compute `total - amount` from
// the same starting figure and one would be lost. The database does the
// arithmetic, so neither is.
//
// The CAP is a different question and is still read-then-write. Two approvers
// deciding two pending adjustments on the same invoice each read the same
// outstanding balance, each is individually within it, and both post — so the
// school can give away more than the bill.
//
// Run: `pnpm --filter @sms/api test:db -- two-waivers-against-one-balance`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeeOpsService } from "../../src/fees/fee-ops.service";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("two adjustments against one balance (real Postgres)", () => {
  let admin: Pool;
  let ops: FeeOpsService;

  const SA = randomUUID();
  const MAKER = randomUUID();
  const CHECKER = randomUUID();
  const STUDENT = randomUUID();
  const INVOICE = randomUUID();
  const ADJ_A = randomUUID();
  const ADJ_B = randomUUID();
  const TOTAL = 10_000_000;
  const EACH = 8_000_000; // each fits alone; together they do not

  const checker = (): Principal => ({ userId: CHECKER, schoolId: SA, roles: ["principal"], permissions: ["fee.approve"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'AD',$2,'NGN',now())`, [SA, "ad-" + SA]);
    for (const [id, n] of [[MAKER, "Bursar"], [CHECKER, "Head"], [STUDENT, "Pupil"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SA, `${id}@ad.test`, n],
      );
    }
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor",currency,status,"dueDate","issuedAt","createdById","updatedAt")
       VALUES ($1,$2,$3,'AD-INV',$4,'NGN','ISSUED',now()+interval '30 days',now(),$5,now())`,
      [INVOICE, SA, STUDENT, TOTAL, MAKER],
    );
    // Two pending waivers, each individually within the outstanding balance.
    for (const [id, reason] of [[ADJ_A, "hardship"], [ADJ_B, "scholarship top-up"]] as const) {
      await admin.query(
        `INSERT INTO invoice_adjustment (id,"schoolId","invoiceId",kind,"amountMinor",reason,status,"requestedById","createdAt","updatedAt")
         VALUES ($1,$2,$3,'WAIVER',$4,$5,'PENDING_APPROVAL',$6,now(),now())`,
        [id, SA, INVOICE, EACH, reason, MAKER],
      );
    }

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    const region = new SchoolRegionService(tenant);
    const fees = new FeesService(tenant, audit, notifications, { isConfigured: () => false } as never, region);
    ops = new FeeOpsService(tenant, audit, notifications, { client: null } as never, fees);
  });

  afterAll(async () => {
    for (const t of ["invoice_adjustment", "payment", "invoice_line_item", "invoice", "notification_delivery", "notification", "audit_log", "\"user\"", "school"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SA]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("does not give away more than the invoice is worth", async () => {
    // Promise.all: two approvers clearing the queue at the same moment (or one
    // approver double-clicking two rows). Sequentially the second correctly
    // sees the reduced balance and is refused.
    const out = await Promise.allSettled([
      ops.decideAdjustment(checker(), ADJ_A, true),
      ops.decideAdjustment(checker(), ADJ_B, true),
    ]);

    const inv = await admin.query(`SELECT "totalMinor"::int AS total FROM invoice WHERE id=$1`, [INVOICE]);
    const approved = out.filter((r) => r.status === "fulfilled").length;
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(`  approved=${approved} invoiceTotal=${inv.rows[0].total}`);

    // A bill cannot be worth less than nothing, and a school cannot waive more
    // than it billed.
    expect(inv.rows[0].total).toBeGreaterThanOrEqual(0);
  });
});
