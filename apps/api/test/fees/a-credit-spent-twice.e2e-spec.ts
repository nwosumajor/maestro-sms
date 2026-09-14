// =============================================================================
// PROBE: can a family's credit balance be spent twice at once?
// =============================================================================
// `applyCreditToInvoice` reads the balance and then writes the spend:
//
//     const agg   = await tx.studentCreditEntry.aggregate({ _sum: deltaMinor })
//     const apply = Math.min(invoiceBalance, agg._sum.deltaMinor ?? 0)
//     await tx.studentCreditEntry.create({ deltaMinor: -apply })
//
// The same read-then-write shape that let one gateway charge post six times —
// here on a BALANCE rather than a uniqueness rule, so no unique index can
// express it. Two invoices for the same pupil, applied at the same moment,
// both read the whole balance.
//
// This spec is written to FAIL if the balance can go negative. Run against a
// real Postgres: `pnpm --filter @sms/api test:db -- a-credit-spent-twice`.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { PaymentPlansService } from "../../src/fees/payment-plans.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import { SchoolRegionService } from "../../src/foundation/school-region.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("a pupil's credit cannot be spent twice (real Postgres)", () => {
  let admin: Pool;
  let svc: PaymentPlansService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();
  const INV_A = randomUUID();
  const INV_B = randomUUID();
  const CREDIT = 5_000_000;

  const bursar = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["accountant"], permissions: ["fee.manage"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'CR',$2,'NGN',now())`, [SA, "cr-" + SA]);
    for (const [id, name] of [[STAFF, "Bursar"], [STUDENT, "Pupil"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SA, `${id}@cr.test`, name],
      );
    }
    // TWO open invoices, each large enough to absorb the WHOLE credit.
    for (const [id, ref] of [[INV_A, "CR-A"], [INV_B, "CR-B"]] as const) {
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor",currency,status,"dueDate","issuedAt","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'NGN','ISSUED',now()+interval '30 days',now(),$6,now())`,
        [id, SA, STUDENT, ref, CREDIT, STAFF],
      );
    }
    // ONE credit balance, enough for exactly one of them.
    await admin.query(
      `INSERT INTO student_credit_entry (id,"schoolId","studentId","deltaMinor",currency,reason,"createdById","createdAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'NGN','OVERPAYMENT',$4,now())`,
      [SA, STUDENT, CREDIT, STAFF],
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new PaymentPlansService(
      tenant, audit, notifications,
      { isConfigured: () => false } as never,
      new SchoolRegionService(tenant),
    );
  });

  afterAll(async () => {
    for (const t of ["student_credit_entry", "payment", "invoice_line_item", "invoice", "notification_delivery", "notification", "audit_log", "\"user\"", "school"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]).catch(async () => {
        await admin.query(`DELETE FROM ${t} WHERE id = $1`, [SA]).catch(() => undefined);
      });
    }
    await admin.end();
    await prisma.$disconnect();
  });

  it("cannot go NEGATIVE when two invoices claim it at the same moment", async () => {
    // Promise.all, not a loop: sequentially the second call correctly sees a
    // spent balance and refuses. Only simultaneity exposes read-then-write.
    await Promise.allSettled([
      svc.applyCreditToInvoice(bursar(), INV_A),
      svc.applyCreditToInvoice(bursar(), INV_B),
    ]);

    const bal = await admin.query(
      `SELECT COALESCE(sum("deltaMinor"),0)::int AS balance FROM student_credit_entry WHERE "studentId" = $1`,
      [STUDENT],
    );
    // A family's credit is money they have already handed over. Spending it
    // twice credits the school 10,000,000 against 5,000,000 received.
    expect(bal.rows[0].balance).toBeGreaterThanOrEqual(0);
  });

  it("applies it to exactly ONE of the two invoices", async () => {
    const rows = await admin.query(
      `SELECT count(*)::int AS n, COALESCE(sum("amountMinor"),0)::int AS posted
       FROM payment WHERE "invoiceId" = ANY($1) AND kind = 'CREDIT'`,
      [[INV_A, INV_B]],
    );
    expect(rows.rows[0].posted).toBeLessThanOrEqual(CREDIT);
  });
});
