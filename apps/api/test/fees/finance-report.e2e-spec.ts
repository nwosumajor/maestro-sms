// =============================================================================
// FeesService.financeReport — receivables aging, computed in SQL (real DB)
// =============================================================================
// The report used to load EVERY non-DRAFT invoice the school had ever issued,
// with its POSTED payments, into Node and add them up in a JS loop. It is now a
// single Postgres aggregate. These cases exist because that rewrite touches
// MONEY: the figures must be identical, not merely plausible, so each one is
// asserted against a hand-computed expectation rather than a snapshot.
//
// Fixture spans all four aging buckets plus the cases the loop treated
// specially — a fully paid invoice (counts toward collected, no bucket), an
// over-refunded one (balance back above zero), and a DRAFT/CANCELLED pair that
// must not appear at all.
//
// Needs TEST_DATABASE_URL (app role; also DATABASE_URL for the Prisma
// singleton) + TEST_ADMIN_URL (superuser, to seed). Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("FeesService.financeReport aging + totals (real Postgres)", () => {
  let admin: Pool;
  let fees: FeesService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();

  // reference           total    due            posted payments      bucket
  const CURRENT = randomUUID(); // 100_000  +10 days   20_000 (PAYMENT)     current, bal 80_000
  const D15 = randomUUID(); //     50_000   -15 days   0                    d1_30,   bal 50_000
  const D45 = randomUUID(); //     30_000   -45 days   10_000               d31_60,  bal 20_000
  const D90 = randomUUID(); //     70_000   -90 days   0                    d60plus, bal 70_000
  const SETTLED = randomUUID(); //  40_000  -20 days   40_000               none,    bal 0
  const REFUNDED = randomUUID(); // 25_000  -80 days   25_000 - 25_000      d60plus, bal 25_000
  const DRAFT = randomUUID(); //    99_000  +5 days    —                    EXCLUDED
  const CANCELLED = randomUUID(); // 88_000 -5 days    —                    EXCLUDED

  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["accountant"], permissions: ["fee.read"] });
  const parent = (): Principal => ({ userId: randomUUID(), schoolId: SA, roles: ["parent"], permissions: ["fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'FR',$2,now())`, [SA, "fr-" + SA]);
    for (const [u, name] of [
      [STAFF, "Fr Staff"],
      [STUDENT, "Fr Student"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@fr", name]);
    }
    const inv = async (id: string, ref: string, total: number, dueSql: string, status: string) =>
      admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5::"InvoiceStatus",$6,${dueSql},$7,now())`,
        [id, SA, STUDENT, ref, status, total, STAFF],
      );
    // `now() + interval` lands on a DATE column, so the day arithmetic is exact.
    await inv(CURRENT, "FR-CURRENT", 100_000, "now() + interval '10 days'", "ISSUED");
    await inv(D15, "FR-D15", 50_000, "now() - interval '15 days'", "ISSUED");
    await inv(D45, "FR-D45", 30_000, "now() - interval '45 days'", "PARTIALLY_PAID");
    await inv(D90, "FR-D90", 70_000, "now() - interval '90 days'", "ISSUED");
    await inv(SETTLED, "FR-SETTLED", 40_000, "now() - interval '20 days'", "PAID");
    await inv(REFUNDED, "FR-REFUNDED", 25_000, "now() - interval '80 days'", "ISSUED");
    await inv(DRAFT, "FR-DRAFT", 99_000, "now() + interval '5 days'", "DRAFT");
    await inv(CANCELLED, "FR-CANCELLED", 88_000, "now() - interval '5 days'", "CANCELLED");

    const pay = async (invoiceId: string, amount: number, kind: string, status = "POSTED") =>
      admin.query(
        `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,kind,status,reference,"recordedById")
         VALUES ($1,$2,$3,$4,'CASH',$5::"PaymentKind",$6::"PaymentStatus",$7,$8)`,
        [randomUUID(), SA, invoiceId, amount, kind, status, "FR-" + randomUUID().slice(0, 8), STAFF],
      );
    await pay(CURRENT, 20_000, "PAYMENT");
    await pay(D45, 10_000, "PAYMENT");
    await pay(SETTLED, 40_000, "PAYMENT");
    await pay(REFUNDED, 25_000, "PAYMENT");
    await pay(REFUNDED, 25_000, "REFUND"); // nets back to zero paid -> full balance
    // A PENDING_APPROVAL payment must NOT count as collected — it is reported
    // separately so staff can see money parked awaiting a second pair of eyes.
    await pay(D15, 9_000, "PAYMENT", "PENDING_APPROVAL");

    const tenant = new PrismaTenantService() as never;
    const auditLog = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, auditLog, queue as never);
    fees = new FeesService(tenant, auditLog, notifications, { isConfigured: () => false } as never);
  });

  afterAll(async () => {
    for (const t of ["payment", "invoice", "audit_log"]) await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("totals count every billable invoice and only POSTED money", async () => {
    const r = await fees.financeReport(staff());
    if (r.scope !== "school") throw new Error("expected school scope");
    // 100 + 50 + 30 + 70 + 40 + 25 = 315_000. DRAFT (99k) and CANCELLED (88k) excluded.
    expect(r.totals.invoicedMinor).toBe(315_000);
    // 20 + 10 + 40 + (25 - 25) = 70_000. The PENDING_APPROVAL 9k is NOT collected.
    expect(r.totals.collectedMinor).toBe(70_000);
    expect(r.totals.outstandingMinor).toBe(245_000);
  });

  it("splits the outstanding balance across the four aging buckets exactly", async () => {
    const r = await fees.financeReport(staff());
    if (r.scope !== "school") throw new Error("expected school scope");
    expect(r.aging.current).toEqual({ count: 1, amountMinor: 80_000 }); // CURRENT
    expect(r.aging.d1_30).toEqual({ count: 1, amountMinor: 50_000 }); // D15
    expect(r.aging.d31_60).toEqual({ count: 1, amountMinor: 20_000 }); // D45
    // D90 (70k) + REFUNDED (25k, refunded back to a full balance)
    expect(r.aging.d60plus).toEqual({ count: 2, amountMinor: 95_000 });
    // A fully settled invoice is in NO bucket, though its money is collected.
    const bucketed = r.aging.current.count + r.aging.d1_30.count + r.aging.d31_60.count + r.aging.d60plus.count;
    expect(bucketed).toBe(5); // 6 billable invoices, SETTLED excluded
  });

  it("the aging outstanding reconciles with the headline outstanding", async () => {
    const r = await fees.financeReport(staff());
    if (r.scope !== "school") throw new Error("expected school scope");
    const summed =
      r.aging.current.amountMinor + r.aging.d1_30.amountMinor + r.aging.d31_60.amountMinor + r.aging.d60plus.amountMinor;
    // The two are computed by different expressions over the same rows; if the
    // rewrite ever drifts, they stop agreeing before anyone notices the figure.
    expect(summed).toBe(r.totals.outstandingMinor);
  });

  it("reports money parked awaiting approval separately from collected", async () => {
    const r = await fees.financeReport(staff());
    if (r.scope !== "school") throw new Error("expected school scope");
    expect(r.pendingApprovals).toEqual({ count: 1, amountMinor: 9_000 });
  });

  it("returns numbers, never a BigInt — the JSON layer cannot serialize one", async () => {
    const r = await fees.financeReport(staff());
    if (r.scope !== "school") throw new Error("expected school scope");
    for (const v of [r.totals.invoicedMinor, r.totals.collectedMinor, r.aging.d60plus.amountMinor, r.pendingApprovals.amountMinor]) {
      expect(typeof v).toBe("number");
    }
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("a parent gets scope:none, not the school's receivables", async () => {
    expect(await fees.financeReport(parent())).toEqual({ scope: "none" });
  });
});
