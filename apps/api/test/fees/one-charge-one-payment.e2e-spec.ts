// =============================================================================
// Six deliveries at once, against a real Postgres — exactly one payment
// =============================================================================
// The defect this proves fixed was measured live against the running stack: six
// SIMULTANEOUS deliveries of one signed Paystack webhook, the same gateway
// reference on all six, posted SIX payments against a 5,000,000 invoice —
// 30,000,000 credited and the invoice marked PAID from one payment.
//
// `applyOnlinePayment` guarded with findFirst-then-create, which at READ
// COMMITTED lets every concurrent caller read nothing and insert. SEQUENTIAL
// replay was idempotent, so a probe that only replays clears this rail; only
// racing it shows the defect.
//
// Needs TEST_DATABASE_URL (app role) + TEST_ADMIN_URL (superuser, to seed
// across FKs) + DATABASE_URL for the @sms/db singleton — `pnpm --filter
// @sms/api test:db` supplies all three.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("one gateway charge posts once, under concurrency (real Postgres)", () => {
  let admin: Pool;
  let svc: InvoiceSettlementService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();
  const INVOICE = randomUUID();
  const REFERENCE = `RACE-${randomUUID()}`;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RC',$2,now())`, [SA, "rc-" + SA]);
    for (const [id, name] of [[STAFF, "Staff"], [STUDENT, "Pupil"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [id, SA, `${id}@rc.test`, name],
      );
    }
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"totalMinor",currency,status,"dueDate","issuedAt","createdById","updatedAt")
       VALUES ($1,$2,$3,'RC-INV-1',5000000,'NGN','ISSUED',now()+interval '30 days',now(),$4,now())`,
      [INVOICE, SA, STUDENT, STAFF],
    );
    // The constraint under test. `migrate deploy` applies it in CI and on a
    // fresh database; a long-lived test database may predate it.
    await admin.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "payment_invoiceId_reference_key" ON "payment" ("invoiceId","reference")`,
    );

    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new InvoiceSettlementService(
      tenant,
      audit,
      notifications,
      // The REAL method the service calls. A double carrying a plausible
      // neighbour (`assertActive`) fails as a code fault and says nothing about
      // the race under test.
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
    // An undisconnected pool keeps the jest worker alive and hangs CI.
    await prisma.$disconnect();
  });

  const deliver = () =>
    svc.applyOnlinePayment({
      schoolId: SA,
      invoiceId: INVOICE,
      reference: REFERENCE,
      creditMinor: 5_000_000,
      chargedMinor: 5_000_000,
      currency: "NGN",
      payerId: STUDENT,
      method: "CARD",
    } as never);

  it("posts ONE payment when six deliveries arrive together", async () => {
    // Promise.all, not a loop: a sequential loop is the test that passes
    // against the defect.
    const results = await Promise.allSettled([deliver(), deliver(), deliver(), deliver(), deliver(), deliver()]);

    const rows = await admin.query(
      `SELECT count(*)::int AS n, COALESCE(sum("amountMinor"),0)::int AS posted FROM payment WHERE "invoiceId" = $1`,
      [INVOICE],
    );
    expect(rows.rows[0].n).toBe(1);
    expect(rows.rows[0].posted).toBe(5_000_000);

    // AND THE LOSERS DO NOT THROW. Measured with the index but without the
    // P2002 catch, the losing deliveries answered 409 — and a non-2xx is what
    // makes a gateway retry, so the index alone trades a double-post for a
    // retry loop against an invoice already settled.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(0);
  });

  it("leaves the invoice paid exactly once", async () => {
    const inv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [INVOICE]);
    expect(inv.rows[0].status).toBe("PAID");
  });

  it("a LATER replay is still a no-op", async () => {
    await deliver();
    const rows = await admin.query(`SELECT count(*)::int AS n FROM payment WHERE "invoiceId" = $1`, [INVOICE]);
    expect(rows.rows[0].n).toBe(1);
  });
});
