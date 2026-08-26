// =============================================================================
// Funds by department, against a real Postgres
// =============================================================================
// The unit suite beside this one asserts the SQL's TEXT — that it groups by
// currency, that it does not fold unattributed history into tuition. It cannot
// catch a comma. A missing one after the `paid` CTE shipped a 42601 syntax
// error into a running stack with every text assertion green, so this executes
// the query and reconciles the figures against the rows that produced them.
//
// Needs TEST_DATABASE_URL + TEST_ADMIN_URL. Skips otherwise.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FEE_SOURCES } from "@sms/types";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import { SchoolRegionService } from "../../src/foundation/school-region.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("FeesService.revenueBySource (real Postgres)", () => {
  let admin: Pool;
  let fees: FeesService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();

  // Single-source: 100,000 of tuition, 40,000 paid.
  const TUI = randomUUID();
  // Mixed: 60,000 hostel + 40,000 transport = 100,000, half paid. The
  // apportionment must split 30,000 / 20,000, and report all 50,000 as mixed.
  const MIXED = randomUUID();
  // Library fine, unpaid.
  const LIB = randomUUID();
  // A line written before sources existed — its own bucket, never tuition.
  const OLD = randomUUID();
  // CANCELLED: excluded entirely. An unissued bill is not revenue.
  const DEAD = randomUUID();
  // Paid, with NO line items at all — the money the apportionment cannot reach.
  const LINELESS = randomUUID();

  const staff = (): Principal => ({
    userId: STAFF,
    schoolId: SA,
    roles: ["accountant"],
    permissions: ["fee.read", "fee.manage"],
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,'RBS',$2,now())`, [SA, "rbs-" + SA]);
    for (const u of [STAFF, STUDENT]) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'RBS','x',now())`,
        [u, SA, u + "@rbs"],
      );
    }
    const inv = async (id: string, ref: string, total: number, status: string) =>
      admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5::"InvoiceStatus",'NGN',$6,now(),$7,now())`,
        [id, SA, STUDENT, ref, status, total, STAFF],
      );
    const line = async (invoiceId: string, amount: number, source: string | null) =>
      admin.query(
        `INSERT INTO invoice_line_item (id,"schoolId","invoiceId",description,"amountMinor",quantity,source)
         VALUES ($1,$2,$3,'x',$4,1,$5)`,
        [randomUUID(), SA, invoiceId, amount, source],
      );
    const pay = async (invoiceId: string, amount: number, kind = "PAYMENT", status = "POSTED") =>
      admin.query(
        `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,kind,status,reference,"recordedById")
         VALUES ($1,$2,$3,$4,'CASH',$5::"PaymentKind",$6::"PaymentStatus",$7,$8)`,
        [randomUUID(), SA, invoiceId, amount, kind, status, "RBS-" + randomUUID().slice(0, 8), STAFF],
      );

    await inv(TUI, "RBS-TUI", 100_000, "PARTIALLY_PAID");
    await line(TUI, 100_000, FEE_SOURCES.TUITION);
    await pay(TUI, 40_000);

    await inv(MIXED, "RBS-MIXED", 100_000, "PARTIALLY_PAID");
    await line(MIXED, 60_000, FEE_SOURCES.HOSTEL);
    await line(MIXED, 40_000, FEE_SOURCES.TRANSPORT);
    await pay(MIXED, 50_000);

    await inv(LIB, "RBS-LIB", 5_000, "ISSUED");
    await line(LIB, 5_000, FEE_SOURCES.LIBRARY);

    await inv(OLD, "RBS-OLD", 7_000, "ISSUED");
    await line(OLD, 7_000, null);

    await inv(DEAD, "RBS-DEAD", 999_000, "CANCELLED");
    await line(DEAD, 999_000, FEE_SOURCES.TUITION);
    await pay(DEAD, 999_000);

    await inv(LINELESS, "RBS-LINELESS", 0, "ISSUED");
    await pay(LINELESS, 3_000);

    const tenant = new PrismaTenantService() as never;
    const auditLog = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, auditLog, queue as never);
    fees = new FeesService(tenant, auditLog, notifications, { isConfigured: () => false } as never, new SchoolRegionService(tenant));
  });

  afterAll(async () => {
    for (const t of ["payment", "invoice_line_item", "invoice", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  const only = async () => {
    const out = await fees.revenueBySource(staff());
    expect(out).toHaveLength(1);
    return out[0];
  };
  const of = (r: Awaited<ReturnType<typeof only>>, source: string) =>
    r.sources.find((s) => s.source === source);

  it("runs at all — the SQL is valid, which no text assertion can tell you", async () => {
    await expect(only()).resolves.toBeDefined();
  });

  it("bills each department exactly what its own lines say", async () => {
    const r = await only();
    expect(of(r, "TUITION")?.billedMinor).toBe(100_000);
    expect(of(r, "HOSTEL")?.billedMinor).toBe(60_000);
    expect(of(r, "TRANSPORT")?.billedMinor).toBe(40_000);
    expect(of(r, "LIBRARY")?.billedMinor).toBe(5_000);
  });

  it("keeps a line written before sources existed in its OWN bucket", async () => {
    const r = await only();
    expect(of(r, "UNATTRIBUTED")?.billedMinor).toBe(7_000);
    // …and specifically NOT added to tuition, which is the tempting default.
    expect(of(r, "TUITION")?.billedMinor).toBe(100_000);
  });

  it("splits a mixed bill's payment in proportion to what each department charged", async () => {
    const r = await only();
    expect(of(r, "HOSTEL")?.collectedMinor).toBe(30_000); // 60% of 50,000
    expect(of(r, "TRANSPORT")?.collectedMinor).toBe(20_000); // 40%
  });

  it("says how much of the collected figure rests on that split", async () => {
    const r = await only();
    expect(r.mixedCollectedMinor).toBe(50_000);
  });

  it("counts money paid against a bill with NO lines, instead of losing it", async () => {
    // Seeded live before this arm existed: ₦5,000 posted against a lineless
    // invoice and the collected figure did not move. A finance report quietly
    // worth less than the bank.
    const r = await only();
    expect(of(r, "UNATTRIBUTED")?.collectedMinor).toBe(3_000);
  });

  it("excludes a CANCELLED invoice entirely, billed AND paid", async () => {
    const r = await only();
    expect(r.billedMinor).not.toBe(1_211_000);
    expect(of(r, "TUITION")?.billedMinor).toBe(100_000);
  });

  it("RECONCILES: the totals equal the rows that produced them", async () => {
    // The property the whole report stands on. Billed is every line on a
    // non-cancelled invoice; collected is every posted payment on one.
    const r = await only();
    expect(r.billedMinor).toBe(100_000 + 60_000 + 40_000 + 5_000 + 7_000);
    expect(r.collectedMinor).toBe(40_000 + 50_000 + 3_000);
    expect(r.sources.reduce((n, s) => n + s.billedMinor, 0)).toBe(r.billedMinor);
    expect(r.sources.reduce((n, s) => n + s.collectedMinor, 0)).toBe(r.collectedMinor);
  });
});
