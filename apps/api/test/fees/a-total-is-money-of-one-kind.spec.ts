// =============================================================================
// A total that adds two currencies is not a total
// =============================================================================
// An invoice carries its OWN currency — a school bills international families
// USD through Stripe alongside its local currency — and a payment inherits its
// invoice's. Four of the accountant's five money screens summed across that
// without noticing:
//
//   /fees          `invoiceSummary`  — and hard-coded `currency: "NGN"`, with a
//                  comment saying "the ledger is single-currency per school in
//                  practice". Wrong twice: a Ghanaian school's outstanding
//                  total was LABELLED in naira, and a USD-billing school had
//                  cents added into its kobo.
//   /admin         the same summary, defaulting to "NGN" on its own side too.
//   /analytics     an ungrouped SUM, rendered by a KPI card calling bare
//                  `money()` — directly above a chart that had ALREADY been
//                  corrected to the school's currency, so one page disagreed
//                  with itself.
//   /fees/reports  totals, four aging buckets and pending approvals, all
//                  ungrouped.
//
// THE REASONING WAS ALREADY WRITTEN DOWN, one directory away. The group
// console's cross-campus money says it outright: "a payment carries no currency
// of its own — it inherits its INVOICE's. So the collected figures join through
// to the invoice rather than assuming NGN, which is precisely the assumption
// that made the old totals wrong." Somebody worked it out for the console the
// directors read and left the screens the school's own accountant reconciles
// against. The same shape as the operator revenue ledger, which refuses to sum
// across currencies BY DESIGN and says so in its header.
//
// There is no FX rate in this platform, so the fix is never to convert: the
// school's own currency leads and every other is reported beside it.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import { SchoolRegionService } from "../../src/foundation/school-region.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("the headline figures on /fees and /admin (real Postgres)", () => {
  let admin: Pool;
  let fees: FeesService;

  // A GHANAIAN school. The label was the literal "NGN" whatever this said, so a
  // school billing in cedis read its own receivables as naira.
  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();

  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["accountant"], permissions: ["fee.read"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'TS',$2,'GHS',now())`, [SA, "ts-" + SA]);
    for (const [u, name] of [[STAFF, "Ts Staff"], [STUDENT, "Ts Student"]] as const) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`, [u, SA, u + "@ts", name]);
    }
    const inv = async (ref: string, total: number, currency: string, overdue: boolean) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,'ISSUED',$5,$6,now() ${overdue ? "- interval '10 days'" : "+ interval '10 days'"},$7,now())`,
        [id, SA, STUDENT, ref, currency, total, STAFF],
      );
      return id;
    };
    const ghs = await inv("TS-GHS", 100_000, "GHS", true); // GHS 1,000, overdue
    const usd = await inv("TS-USD", 20_000, "USD", true); //  $200, overdue
    for (const [invoiceId, amount] of [[ghs, 40_000], [usd, 5_000]] as const) {
      await admin.query(
        `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,kind,status,"recordedById")
         VALUES ($1,$2,$3,$4,'CASH','PAYMENT','POSTED',$5)`,
        [randomUUID(), SA, invoiceId, amount, STAFF],
      );
    }
    const tenant = new PrismaTenantService() as never;
    const auditLog = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    fees = new FeesService(
      tenant,
      auditLog,
      new NotificationService(tenant, auditLog, queue as never),
      { isConfigured: () => false } as never,
      new SchoolRegionService(tenant),
    );
  });

  afterAll(async () => {
    for (const t of ["payment", "invoice", "audit_log"]) await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("names the SCHOOL's currency, not the platform's", async () => {
    // This was the literal "NGN", returned to every school on the platform.
    const s = await fees.invoiceSummary(staff());
    expect(s.currency).toBe("GHS");
  });

  it("puts only cedis in the cedi figures", async () => {
    const s = await fees.invoiceSummary(staff());
    // GHS 1,000 billed, GHS 400 paid. The $200 invoice contributes NOTHING:
    // before the split it added 20,000 to outstanding and 5,000 to collected as
    // though cents were pesewas.
    expect({ outstandingMinor: s.outstandingMinor, collectedMinor: s.collectedMinor }).toEqual({
      outstandingMinor: 60_000,
      collectedMinor: 40_000,
    });
  });

  it("reports the dollars beside them, never folded in", async () => {
    const s = await fees.invoiceSummary(staff());
    expect(s.byCurrency).toEqual([
      { currency: "GHS", outstandingMinor: 60_000, collectedMinor: 40_000, overdueCount: 1 },
      { currency: "USD", outstandingMinor: 15_000, collectedMinor: 5_000, overdueCount: 1 },
    ]);
  });

  it("counts overdue invoices in EVERY currency — a late bill is late in any money", async () => {
    // The count is currency-independent and must not be split away to zero:
    // the headline `overdueCount` is the school's own currency (what the tile
    // links to), and the per-currency rows carry the rest.
    const s = await fees.invoiceSummary(staff());
    expect(s.overdueCount).toBe(1);
    expect(s.byCurrency.reduce((n, b) => n + b.overdueCount, 0)).toBe(2);
  });

  it("a school with NO invoices in its own currency still leads with it, at zero", async () => {
    // The failure this prevents: a school that happens to have raised only
    // dollar bills this term gets USD promoted into the slot every tile reads
    // as "our money", and the figures silently change meaning without changing
    // shape. Proved by asking a school whose ledger holds no GHS row at all.
    const EMPTY = randomUUID();
    const EMPTY_STAFF = randomUUID();
    const EMPTY_STUDENT = randomUUID();
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'TS2',$2,'GHS',now())`, [EMPTY, "ts2-" + EMPTY]);
    for (const u of [EMPTY_STAFF, EMPTY_STUDENT]) {
      await admin.query(`INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'X','x',now())`, [u, EMPTY, u + "@ts2"]);
    }
    await admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
       VALUES ($1,$2,$3,'TS2-USD','ISSUED','USD',7_500,now(),$4,now())`,
      [randomUUID(), EMPTY, EMPTY_STUDENT, EMPTY_STAFF],
    );
    try {
      const s = await fees.invoiceSummary({ userId: EMPTY_STAFF, schoolId: EMPTY, roles: ["accountant"], permissions: ["fee.read"] });
      expect(s.currency).toBe("GHS");
      expect(s.outstandingMinor).toBe(0);
      expect(s.byCurrency.map((b) => b.currency)).toEqual(["GHS", "USD"]);
      expect(s.byCurrency[1].outstandingMinor).toBe(7_500);
    } finally {
      for (const t of ["payment", "invoice", "audit_log"]) await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [EMPTY]);
      await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [EMPTY]);
      await admin.query(`DELETE FROM school WHERE id = $1`, [EMPTY]);
    }
  });
});
