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
import { inflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { prisma } from "@sms/db";
import { FeeOpsService } from "../../src/fees/fee-ops.service";
import { FeesService } from "../../src/fees/fees.service";
import { NotificationService } from "../../src/notifications/notification.service";
import { PrismaTenantService } from "../../src/foundation/prisma-tenant.service";
import { AuditLogService } from "../../src/foundation/audit-log.service";
import type { Principal } from "../../src/integrity/integrity.foundation";
import { SchoolRegionService } from "../../src/foundation/school-region.service";

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = APP_URL && ADMIN_URL ? describe : describe.skip;

d("FeeOpsService adjustments + late fees + receipts + journal (real Postgres)", () => {
  let admin: Pool;
  let svc: FeeOpsService;
  let fees: FeesService;

  const SA = randomUUID();
  const MAKER = randomUUID(); // accountant requesting
  const CHECKER = randomUUID(); // principal approving
  const GUARDIAN = randomUUID();
  const OUTSIDER = randomUUID(); // unrelated parent
  const STUDENT = randomUUID();
  const adjInvoice = randomUUID(); // 100k — gets a 20k discount
  const lateInvoice = randomUUID(); // overdue past grace — gets the late fee
  const freshInvoice = randomUUID(); // due in future — must be untouched
  const approverRole = randomUUID(); // fixture role carrying fee.approve (global table)
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
    // A SECOND APPROVER HAS TO EXIST IN THE DATABASE, not just in a Principal.
    //
    // `requestAdjustment` refuses to raise a maker-checker request at all when
    // nobody else could ever decide it — a two-person rule with one person is a
    // dead end, not a control. That guard asks `user_role`, so the checker's
    // `fee.approve` has to be a real role grant here; carrying it on the
    // Principal alone told the service the school had exactly one approver.
    const feeApprove = randomUUID();
    await admin.query(`INSERT INTO role (id,name,description) VALUES ($1,$2,'fixture approver')`, [approverRole, "fo-approver-" + SA.slice(0, 8)]);
    await admin.query(`INSERT INTO permission (id,key) VALUES ($1,'fee.approve') ON CONFLICT (key) DO NOTHING`, [feeApprove]);
    await admin.query(
      `INSERT INTO role_permission ("roleId","permissionId") SELECT $1,p.id FROM permission p WHERE p.key = 'fee.approve'`,
      [approverRole],
    );
    await admin.query(`INSERT INTO user_role (id,"schoolId","userId","roleId") VALUES ($1,$2,$3,$4)`, [
      randomUUID(),
      SA,
      CHECKER,
      approverRole,
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
    fees = new FeesService(tenant, audit, notifications, { isConfigured: () => false } as never, new SchoolRegionService(tenant));
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
      // The approver role assignment seeded above — a CHILD of `user`, so it
      // goes before the users do or the delete violates the FK.
      "user_role",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE "schoolId" = $1`, [SA]);
    }
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = $1`, [SA]);
    // The fixture's own role (role and role_permission are GLOBAL — no schoolId
    // — so the loop above cannot reach them, and a run would otherwise leave a
    // "fo-approver-…" role behind in every test database for ever).
    await admin.query(`DELETE FROM role_permission WHERE "roleId" = $1`, [approverRole]);
    await admin.query(`DELETE FROM role WHERE id = $1`, [approverRole]);
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

  /**
   * The text a payer actually sees.
   *
   * pdfkit FLATE-compresses its content streams and writes text as HEX runs, so
   * the bytes have to be inflated and the runs glued back together. Same
   * technique as `reportcard-pdf.spec.ts`, and the CP1252 mapping matters: an em
   * dash is 0x97 there, which latin1 treats as a control character — read
   * without the mapping it silently disappears and reads as a double space. It
   * cost me one false finding before I checked the byte.
   */
  function receiptText(pdf: Buffer): string {
    const out: string[] = [];
    let i = 0;
    for (;;) {
      const st = pdf.indexOf("\nstream", i);
      if (st === -1) break;
      let from = st + 7;
      while (pdf[from] === 0x0d || pdf[from] === 0x0a) from += 1;
      const e = pdf.indexOf("endstream", from);
      if (e === -1) break;
      i = e + 9;
      let raw: string;
      try {
        raw = inflateSync(pdf.subarray(from, e)).toString("latin1");
      } catch {
        continue;
      }
      for (const chunk of raw.split(/\bTm\b/)) {
        const line = [...chunk.matchAll(/<([0-9A-Fa-f]+)>/g)]
          .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
          .join("");
        if (line.trim()) out.push(line.trim());
      }
    }
    return out.join("\n");
  }

  it("receipt PDF: guardian downloads it; an unrelated parent gets 404", async () => {
    const { buffer, filename } = await svc.receiptPdf(guardian(), paymentId);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(filename).toMatch(/^RCP-\d{8}-[0-9A-F]{8}\.pdf$/);
    await expect(svc.receiptPdf(outsider(), paymentId)).rejects.toMatchObject({ status: 404 });
  });

  /**
   * WHAT THE RECEIPT SAYS, not merely that it is a PDF.
   *
   * The test above proves the bytes start `%PDF-` and that an outsider gets 404.
   * It cannot see a wrong FIGURE, and this artifact has carried two money bugs
   * already: a `minor / 100` under a hard-coded `en-NG` that printed a
   * CFA-franc receipt at a hundredth of its value, and a naira symbol pdfkit
   * could not draw, which came out as a broken bar. Both were visible only to
   * whoever opened the file — the one document every payer reads.
   */
  it("receipt PDF: the figure on it is the payment that was recorded", async () => {
    const { buffer } = await svc.receiptPdf(guardian(), paymentId);
    const text = receiptText(buffer);
    expect(text).toContain("OFFICIAL RECEIPT");
    // The fixture posts 25000 minor units in the school's currency.
    expect(text).toMatch(/Amount received:\s*NGN\s*250\.00/);
  });

  it("receipt PDF: money is named by its ISO code, never a symbol pdfkit cannot draw", () => {
    // The guard is on the BYTES: pdfkit's built-in fonts are WinAnsi, and a
    // naira sign there emits 0xA6 — the BROKEN BAR — so a receipt read
    // `¦250.00`. Asserting the rendered text alone would not catch a symbol
    // that survives as the wrong glyph.
    // On the DECODED text, not the raw file: a PDF's content streams are
    // deflate-compressed, so 0xA6 turns up in them by chance and asserting on
    // the buffer fails against a perfectly good receipt. My first version did
    // exactly that and this test caught it.
    return svc.receiptPdf(guardian(), paymentId).then(({ buffer }) => {
      const text = receiptText(buffer);
      expect(text).not.toContain("\xa6"); // the broken bar a naira sign becomes
      expect(text).not.toMatch(/[₦₵]/);
      expect(text).toContain("NGN");
    });
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

  // ===========================================================================
  // Invoice list: filtering, cursor paging, and the summary totals
  // ===========================================================================
  // Expectations are re-derived from the DB, because the tests above deliberately
  // mutate this fixture (a discount is applied, a late fee is added).
  describe("list, paging and summary", () => {
    const sumFromDb = async (): Promise<{ outstanding: number; collected: number }> => {
      const r = await admin.query<{ o: string; c: string }>(
        `WITH billable AS (
           SELECT id, "totalMinor" FROM invoice
           WHERE "schoolId" = $1 AND status IN ('ISSUED','PARTIALLY_PAID','PAID')
         ), paid AS (
           SELECT "invoiceId", SUM(CASE WHEN kind = 'REFUND' THEN -"amountMinor" ELSE "amountMinor" END) AS amt
           FROM payment WHERE status = 'POSTED' AND "invoiceId" IN (SELECT id FROM billable)
           GROUP BY "invoiceId"
         )
         SELECT COALESCE(SUM(b."totalMinor" - COALESCE(p.amt,0)),0)::text AS o,
                COALESCE(SUM(COALESCE(p.amt,0)),0)::text AS c
         FROM billable b LEFT JOIN paid p ON p."invoiceId" = b.id`,
        [SA],
      );
      return { outstanding: Number(r.rows[0].o), collected: Number(r.rows[0].c) };
    };

    it("summarises outstanding, collected and overdue over the WHOLE visible set", async () => {
      const got = await fees.invoiceSummary(maker());
      const want = await sumFromDb();
      expect(got.outstandingMinor).toBe(want.outstanding);
      expect(got.collectedMinor).toBe(want.collected);
      // The fixture has an invoice due 10 days ago that is still owing.
      expect(got.overdueCount).toBeGreaterThanOrEqual(1);
    });

    it("the summary is NOT a sum of the page on screen", async () => {
      // One invoice per page, but the totals must still cover every invoice —
      // otherwise the headline figure silently changes as you page.
      const page = await fees.listInvoices(maker(), { limit: 1 });
      expect(page.items).toHaveLength(1);
      const summary = await fees.invoiceSummary(maker());
      const want = await sumFromDb();
      expect(summary.outstandingMinor).toBe(want.outstanding);
      expect(summary.outstandingMinor).toBeGreaterThan(0);
    });

    it("pages by cursor without skipping or repeating a row", async () => {
      const all = await fees.listInvoices(maker(), { limit: 100 });
      expect(all.nextCursor).toBeNull(); // one page holds the fixture
      const total = all.items.length;
      expect(total).toBeGreaterThanOrEqual(3);

      // Walk it one at a time and confirm we see exactly the same set, once each.
      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await fees.listInvoices(maker(), { limit: 1, cursor: cursor ?? undefined });
        seen.push(...(page.items as Array<{ id: string }>).map((i) => i.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total); // no repeats
      expect(new Set(seen)).toEqual(new Set((all.items as Array<{ id: string }>).map((i) => i.id)));
    });

    it("filters by reference — how staff look one up from a parent's copy", async () => {
      const hit = await fees.listInvoices(maker(), { q: "FO-LATE" });
      expect((hit.items as Array<{ reference: string }>).map((i) => i.reference)).toEqual(["INV-FO-LATE"]);
      // Case-insensitive, because nobody types the reference in caps.
      const lower = await fees.listInvoices(maker(), { q: "fo-late" });
      expect(lower.items).toHaveLength(1);
      expect(await fees.listInvoices(maker(), { q: "nothing-matches" })).toMatchObject({ items: [], nextCursor: null });
    });

    it("scopes both the list and the summary to the caller's own children", async () => {
      // The guardian sees their child's invoices and a summary over just those.
      const mine = await fees.listInvoices(guardian(), { limit: 100 });
      expect(mine.items.length).toBeGreaterThan(0);
      const mineSummary = await fees.invoiceSummary(guardian());
      expect(mineSummary.outstandingMinor).toBeGreaterThan(0);

      // An unrelated parent sees nothing — and a summary of zero, not the school's.
      const none = await fees.listInvoices(outsider(), { limit: 100 });
      expect(none.items).toEqual([]);
      const noneSummary = await fees.invoiceSummary(outsider());
      expect(noneSummary).toMatchObject({ outstandingMinor: 0, collectedMinor: 0, overdueCount: 0 });
    });
  });
});
