// =============================================================================
// A credit balance is a number of minor units, and nothing said of what
// =============================================================================
// `student_credit_entry` recorded `deltaMinor` and no currency, while every row
// that feeds it or spends it carries one: an OVERPAYMENT is in the source
// INVOICE's currency, a dedicated-account transfer is in the CHARGE's, and
// APPLIED spends into the TARGET invoice's. Invoices carry their own currency
// per row — a school bills USD through Stripe alongside its local currency — so
// the balance was a sum over two different kinds of money.
//
// Measured live before the fix, on the running stack: two guardians raced to
// pay one $100 USD invoice, the excess moved to credit as `10000`, and applying
// it to a naira bill credited `10000` KOBO — ₦100 against $100, about a
// thousandth of it, with `{"appliedMinor":10000}` and a PARTIALLY_PAID invoice
// reporting success to everybody. The reverse is worse: ₦100,000 of overpayment
// is 10,000,000 kobo and would credit $100,000.00 against a USD invoice.
//
// ONE PRODUCER HAD ALREADY SEEN THIS AND SAID SO. `initPrepay` raises its
// charge in the school's own currency with a comment reading "crediting a
// ledger in one currency from a charge in another is a balance that silently
// drifts" — correct, and applied to one of the four producers and neither of
// the two consumers. The sibling asymmetry this repo keeps finding: the
// dedicated-account handler passes `event.data.currency` to
// `applyOnlinePayment` on the branch where an open invoice exists, and passed
// nothing at all to the credit branch four lines below.
//
// There is no FX rate in this platform. Converting would be worse than
// refusing, the same decision `school.paymentApprovalThresholdMinor` records,
// so credit is spendable only on an invoice in its own currency and the refusal
// says which of "no credit" and "no credit in THIS currency" it is.
// =============================================================================

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import {
  PaymentPlansService,
  creditCurrencyWhere,
  creditEntryCurrency,
} from "../../src/fees/payment-plans.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import { SchoolRegionService } from "../../src/foundation/school-region.service";

describe("what currency a ledger row is in", () => {
  it("is what the row says", () => {
    expect(creditEntryCurrency("USD", "NGN")).toBe("USD");
  });

  it("is the SCHOOL's when the row predates the column", () => {
    // Rows written before the column existed cannot say what they were. The
    // school's own currency is the only assumption the data supports — it is
    // the one `initPrepay` has always raised its charges in — and a backfill
    // would have recorded that guess as though it were a fact.
    expect(creditEntryCurrency(null, "NGN")).toBe("NGN");
    expect(creditEntryCurrency(null, "GHS")).toBe("GHS");
  });

  it("makes historical rows spendable in the school's currency and NOWHERE else", () => {
    // The half that is easy to get wrong. A bare `{ currency }` filter would
    // orphan every row written before the migration: a family's money still on
    // the screen and no invoice able to spend it.
    expect(creditCurrencyWhere("NGN", "NGN")).toEqual({ OR: [{ currency: "NGN" }, { currency: null }] });
    expect(creditCurrencyWhere("USD", "NGN")).toEqual({ currency: "USD" });
  });
});

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("a pupil holding credit in two currencies (real Postgres)", () => {
  let admin: Pool;
  let svc: PaymentPlansService;

  const SA = randomUUID();
  const STAFF = randomUUID();
  const STUDENT = randomUUID();
  const usdOverpaid = randomUUID(); // $100 billed, $200 paid
  const ngnOpen = randomUUID(); // ₦50,000 open
  const usdOpen = randomUUID(); // $60 open

  const staff = (): Principal => ({ userId: STAFF, schoolId: SA, roles: ["school_admin"], permissions: ["fee.manage"] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    // A school on the platform's own currency that ALSO bills some families in
    // dollars — the shape the USD-via-Stripe rail exists for.
    await admin.query(`INSERT INTO school (id,name,slug,currency,"updatedAt") VALUES ($1,'CC',$2,'NGN',now())`, [SA, "cc-" + SA]);
    for (const [u, name] of [[STAFF, "Staff"], [STUDENT, "Cc Student"]] as const) {
      await admin.query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,$4,'x',now())`,
        [u, SA, u + "@cc", name],
      );
    }
    for (const [id, ref, total, status, currency] of [
      [usdOverpaid, "INV-CC-USD", 10_000, "PAID", "USD"],
      [ngnOpen, "INV-CC-NGN", 5_000_000, "ISSUED", "NGN"],
      [usdOpen, "INV-CC-USD2", 6_000, "ISSUED", "USD"],
    ] as const) {
      await admin.query(
        `INSERT INTO invoice (id,"schoolId","studentId",reference,status,currency,"totalMinor","dueDate","createdById","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '30 days',$8,now())`,
        [id, SA, STUDENT, ref, status, currency, total, STAFF],
      );
    }
    // Two guardians both paid the $100 invoice: $200 posted against it.
    for (const _ of [0, 1]) {
      await admin.query(
        `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById") VALUES ($1,$2,$3,10000,'CARD',$4)`,
        [randomUUID(), SA, usdOverpaid, STAFF],
      );
    }
    const tenant = new PrismaTenantService() as never;
    const audit = new AuditLogService();
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const notifications = new NotificationService(tenant, audit, queue as never);
    svc = new PaymentPlansService(
      tenant,
      audit,
      notifications,
      { isConfigured: () => true } as never,
      new SchoolRegionService(tenant),
    );
  });

  afterAll(async () => {
    for (const t of ["student_credit_entry", "invoice_installment", "payment", "invoice", "notification_delivery", "notification", "audit_log"]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    await admin.query(`DELETE FROM school WHERE id = $1`, [SA]);
    await admin.end();
    await prisma.$disconnect();
  });

  it("moves an overpayment into the SOURCE INVOICE's currency, not the school's", async () => {
    const { movedMinor } = await svc.moveOverpaymentToCredit(staff(), usdOverpaid);
    expect(movedMinor).toBe(10_000); // US cents
    const row = await admin.query(
      `SELECT currency,"deltaMinor" FROM student_credit_entry WHERE "schoolId" = $1 AND reason = 'OVERPAYMENT'`,
      [SA],
    );
    expect(row.rows[0]).toMatchObject({ currency: "USD", deltaMinor: 10_000 });
  });

  it("reports the balance PER CURRENCY, and `balanceMinor` is the school's own", async () => {
    const bal = await svc.creditBalance(staff(), STUDENT);
    // The figure the pupil has in the school's own money is ZERO. Before this,
    // the same read answered 10,000 — which a naira school renders as ₦100.
    expect({ currency: bal.currency, balanceMinor: bal.balanceMinor }).toEqual({ currency: "NGN", balanceMinor: 0 });
    expect(bal.balances).toEqual([{ currency: "USD", balanceMinor: 10_000 }]);
    expect(bal.entries[0].currency).toBe("USD");
  });

  it("REFUSES to spend dollar credit on a naira invoice, and says why", async () => {
    // The defect, in one call. Before: 201, `{"appliedMinor":10000}`, the naira
    // invoice PARTIALLY_PAID by ₦100 and the family's $100 gone.
    await expect(svc.applyCreditToInvoice(staff(), ngnOpen)).rejects.toMatchObject({
      status: 400,
      // "no credit at all" and "credit you cannot spend HERE" are different
      // answers to the person reading them: the second is visible on the
      // pupil's other invoice and would otherwise be reported as a bug.
      message: expect.stringContaining("another currency"),
    });
    const inv = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [ngnOpen]);
    expect((inv.rows[0] as { status: string }).status).toBe("ISSUED");
    const pay = await admin.query(`SELECT count(*)::int AS n FROM payment WHERE "invoiceId" = $1`, [ngnOpen]);
    expect((pay.rows[0] as { n: number }).n).toBe(0);
  });

  it("spends it on a DOLLAR invoice, and stamps the APPLIED row with that currency", async () => {
    const { appliedMinor } = await svc.applyCreditToInvoice(staff(), usdOpen);
    expect(appliedMinor).toBe(6_000); // min($60 due, $100 credit)
    const row = await admin.query(
      `SELECT currency,"deltaMinor" FROM student_credit_entry WHERE "schoolId" = $1 AND reason = 'APPLIED'`,
      [SA],
    );
    expect(row.rows[0]).toMatchObject({ currency: "USD", deltaMinor: -6_000 });
    const bal = await svc.creditBalance(staff(), STUDENT);
    expect(bal.balances).toEqual([{ currency: "USD", balanceMinor: 4_000 }]);
    expect(bal.balanceMinor).toBe(0); // still nothing in naira
  });

  it("a prepay webhook records the currency the GATEWAY says it charged", async () => {
    await svc.applyPrepayment({
      event: "charge.success",
      data: {
        amount: 250_000,
        currency: "ngn",
        reference: "CC-PRE-1",
        metadata: { kind: "prepay", schoolId: SA, studentId: STUDENT },
      },
    } as never);
    const row = await admin.query(
      `SELECT currency FROM student_credit_entry WHERE "schoolId" = $1 AND reference = 'CC-PRE-1'`,
      [SA],
    );
    // Uppercased at the boundary, the way the Stripe adapter already does.
    expect(row.rows[0]).toMatchObject({ currency: "NGN" });
    const bal = await svc.creditBalance(staff(), STUDENT);
    expect(bal.balanceMinor).toBe(250_000); // ₦2,500 — and the $40 is still $40
    expect(bal.balances).toEqual([
      { currency: "NGN", balanceMinor: 250_000 },
      { currency: "USD", balanceMinor: 4_000 },
    ]);
  });

  it("a row written before the column existed is still spendable, in the school's currency", async () => {
    // The back-compat half, exercised rather than asserted: a NULL-currency
    // entry is the shape every live row has today.
    await admin.query(
      `INSERT INTO student_credit_entry (id,"schoolId","studentId","deltaMinor",reason,note) VALUES ($1,$2,$3,100000,'PREPAYMENT','legacy')`,
      [randomUUID(), SA, STUDENT],
    );
    const bal = await svc.creditBalance(staff(), STUDENT);
    expect(bal.balanceMinor).toBe(350_000); // ₦2,500 + the ₦1,000 legacy row
    const { appliedMinor } = await svc.applyCreditToInvoice(staff(), ngnOpen);
    expect(appliedMinor).toBe(350_000);
  });
});
