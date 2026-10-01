// =============================================================================
// Ledger integrity, against a real Postgres
// =============================================================================
// The check judges invoice statuses in SQL by a CASE that is meant to BE
// `invoiceStatusForNet`. Two spellings of one rule is how this codebase keeps
// getting a fifth wrong copy, so the first case here is an AGREEMENT GRID: an
// invoice for each kind of net-paid amount, each deliberately stored with a
// status the helper would NOT give it, and every one must be found with the
// helper's answer as its derived status.
//
// Then the cases the check exists for, including the one found on a live
// database — an invoice marked PAID after the scholarship payment that paid it
// was deleted behind the app's back — and the correction that fixes the label
// without touching money.
//
// The sweep is fleet-wide and other suites leave rows in this database, so
// every assertion is scoped to THIS suite's schools. Runs as the privileged
// role, as the service does. Needs TEST_ADMIN_URL — `pnpm --filter @sms/api
// test:db` supplies it.
// =============================================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@sms/db";
import { LedgerIntegrityService } from "../../src/fees/ledger-integrity.service";
import { invoiceStatusForNet } from "../../src/fees/net-paid";
import type { Principal } from "../../src/integrity/integrity.foundation";

const ADMIN_URL = process.env.TEST_ADMIN_URL;
const d = ADMIN_URL ? describe : describe.skip;

d("ledger integrity (real Postgres)", () => {
  let admin: Pool;
  let client: PrismaClient;
  let svc: LedgerIntegrityService;
  const audit = { record: jest.fn() };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const S1 = randomUUID();
  const S2 = randomUUID();
  const STAFF1 = randomUUID();
  const STAFF2 = randomUUID();
  const BURSAR = randomUUID();
  const PUPIL1 = randomUUID();
  const PUPIL2 = randomUUID();
  const operator: Principal = { schoolId: S1, userId: STAFF1, roles: ["super_admin"], permissions: [] };

  /** The agreement grid: one invoice per net-paid amount, total 1,000. */
  const GRID: Array<{ id: string; net: number; stored: string }> = [-200, 0, 1, 999, 1_000, 1_500].map((net) => {
    const right = invoiceStatusForNet(net, 1_000);
    // A status the helper would NOT give it.
    const stored = right === "PAID" ? "ISSUED" : right === "ISSUED" ? "PAID" : "ISSUED";
    return { id: randomUUID(), net, stored };
  });

  const PAID_BUT_OWING = randomUUID(); // the live case: ₦1,000 of ₦1,500 unpaid
  const CORRECT_PARTIAL = randomUUID(); // a refund leaves it part-paid, labelled so
  const DRAFT_WITH_MONEY = randomUUID(); // not a bill — never judged
  const CANCELLED = randomUUID(); // closed — never judged
  const ZERO_TOTAL = randomUUID(); // nothing owed, nothing paid — not noise
  const SCHOLARSHIP_GONE = randomUUID(); // S2: paid by a scholarship that was then deleted

  const user = (id: string, school: string, role?: string) =>
    admin
      .query(
        `INSERT INTO "user" (id,"schoolId",email,name,"passwordHash","updatedAt") VALUES ($1,$2,$3,'LI','x',now())`,
        [id, school, `${id}@li.test`],
      )
      .then(() =>
        role
          ? admin.query(
              `INSERT INTO user_role (id,"schoolId","userId","roleId") SELECT $1,$2,$3,id FROM role WHERE name = $4`,
              [randomUUID(), school, id, role],
            )
          : undefined,
      );
  const invoice = (id: string, school: string, pupil: string, by: string, total: number, status: string) =>
    admin.query(
      `INSERT INTO invoice (id,"schoolId","studentId",reference,"dueDate","createdById","totalMinor",status,currency,"updatedAt")
       VALUES ($1,$2,$3,$4,now()::date,$5,$6,$7::"InvoiceStatus",'NGN',now())`,
      [id, school, pupil, `LI-${id.slice(0, 8)}`, by, total, status],
    );
  const payment = (school: string, inv: string, by: string, amount: number, kind = "PAYMENT", status = "POSTED") =>
    admin.query(
      `INSERT INTO payment (id,"schoolId","invoiceId","amountMinor",method,"recordedById",kind,status)
       VALUES ($1,$2,$3,$4,'CASH',$5,$6::"PaymentKind",$7::"PaymentStatus")`,
      [randomUUID(), school, inv, amount, by, kind, status],
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    client = new PrismaClient({ datasourceUrl: ADMIN_URL });
    for (const [s, n] of [[S1, "LI One"], [S2, "LI Two"]]) {
      await admin.query(`INSERT INTO school (id,name,slug,"updatedAt") VALUES ($1,$2,$3,now())`, [s, n, `li-${s}`]);
    }
    await user(STAFF1, S1, "teacher");
    await user(STAFF2, S2, "teacher");
    await user(BURSAR, S1, "accountant");
    await user(PUPIL1, S1, "student");
    await user(PUPIL2, S2, "student");

    // The grid. A negative net is a refund larger than what was paid.
    for (const g of GRID) {
      await invoice(g.id, S1, PUPIL1, STAFF1, 1_000, g.stored);
      if (g.net > 0) await payment(S1, g.id, STAFF1, g.net);
      if (g.net < 0) {
        await payment(S1, g.id, STAFF1, 100);
        await payment(S1, g.id, STAFF1, 100 - g.net, "REFUND");
      }
    }
    await invoice(PAID_BUT_OWING, S1, PUPIL1, STAFF1, 1_500, "PAID");
    await payment(S1, PAID_BUT_OWING, STAFF1, 500);
    // A PENDING payment must not count: approving it is a decision not yet taken.
    await payment(S1, PAID_BUT_OWING, STAFF1, 1_000, "PAYMENT", "PENDING_APPROVAL");

    await invoice(CORRECT_PARTIAL, S1, PUPIL1, STAFF1, 1_000, "PARTIALLY_PAID");
    await payment(S1, CORRECT_PARTIAL, STAFF1, 800);
    await payment(S1, CORRECT_PARTIAL, STAFF1, 500, "REFUND");

    await invoice(DRAFT_WITH_MONEY, S1, PUPIL1, STAFF1, 1_000, "DRAFT");
    await payment(S1, DRAFT_WITH_MONEY, STAFF1, 1_000);
    await invoice(CANCELLED, S1, PUPIL1, STAFF1, 1_000, "CANCELLED");
    await invoice(ZERO_TOTAL, S1, PUPIL1, STAFF1, 0, "ISSUED");

    // S2: PAID by a scholarship that a superuser DELETE then removed.
    await invoice(SCHOLARSHIP_GONE, S2, PUPIL2, STAFF2, 2_000, "PAID");
    await payment(S2, SCHOLARSHIP_GONE, STAFF2, 500);

    svc = new LedgerIntegrityService(
      // The audit writer is a double; `runAsTenant` hands it a transaction it ignores.
      { runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never,
      audit as never,
      { client } as never,
      notifications as never,
    );
  });

  afterAll(async () => {
    const ids = [[S1, S2]];
    await admin.query(`DELETE FROM payment WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM invoice WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM user_role WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM "user" WHERE "schoolId" = ANY($1)`, ids);
    await admin.query(`DELETE FROM school WHERE id = ANY($1)`, ids);
    await client.$disconnect();
    await admin.end();
  });

  /** Every mismatch in THIS suite's schools, across every page. */
  async function ours() {
    const rows = [];
    for (let page = 1; ; page += 1) {
      const p = await svc.list(page);
      rows.push(...p.rows.filter((r) => r.schoolId === S1 || r.schoolId === S2));
      if (page * 50 >= p.total) break;
    }
    return new Map(rows.map((r) => [r.invoiceId, r]));
  }

  it("judges by the SAME rule as invoiceStatusForNet, for every kind of net paid", async () => {
    const found = await ours();
    for (const g of GRID) {
      const row = found.get(g.id);
      expect({ net: g.net, found: !!row, derived: row?.derivedStatus }).toEqual({
        net: g.net,
        found: true,
        derived: invoiceStatusForNet(g.net, 1_000),
      });
      expect(row!.netPaidMinor).toBe(g.net);
    }
  });

  it("finds the live case — PAID with money owed — and names it", async () => {
    const row = (await ours()).get(PAID_BUT_OWING)!;
    expect(row).toMatchObject({
      kind: "PAID_BUT_OWING",
      status: "PAID",
      derivedStatus: "PARTIALLY_PAID",
      // The pending ₦1,000 does not count.
      netPaidMinor: 500,
      totalMinor: 1_500,
      schoolName: "LI One",
    });
  });

  it("classifies each disagreement by what it costs", async () => {
    const found = await ours();
    const kindOf = (net: number) => found.get(GRID.find((g) => g.net === net)!.id)!.kind;
    expect(kindOf(1_000)).toBe("OPEN_BUT_SETTLED"); // stored ISSUED, settled — a family chased
    expect(kindOf(0)).toBe("PAID_BUT_OWING"); // stored PAID, nothing paid
    expect(kindOf(1)).toBe("PARTIAL_MISLABELLED"); // stored ISSUED, part paid
  });

  it("leaves alone what is right, or not a bill: a correct part-payment, a draft, a cancelled bill, a zero total", async () => {
    const found = await ours();
    for (const id of [CORRECT_PARTIAL, DRAFT_WITH_MONEY, CANCELLED, ZERO_TOTAL]) expect(found.has(id)).toBe(false);
    // Exactly the grid, the live case and S2's — nothing else in our schools.
    expect(found.size).toBe(GRID.length + 2);
  });

  it("sweeps the fleet, counts schools, and alerts the owner while anything disagrees", async () => {
    notifications.enqueue.mockClear();
    const r = await svc.sweep("MANUAL");
    // Fleet-wide, so at LEAST ours: other suites' rows share this database.
    expect(r.mismatched).toBeGreaterThanOrEqual(GRID.length + 2);
    expect(r.paidButOwing + r.openButSettled + r.partialMislabelled).toBe(r.mismatched);
    expect(r.schools).toBeGreaterThanOrEqual(2);
    expect(r.failed).toBe(0);
    expect(r.scanned).toBeGreaterThanOrEqual(r.mismatched);
  });

  it("re-derives ONE label from the ledger, moves no money, audits both tenants and tells finance", async () => {
    audit.record.mockClear();
    notifications.enqueue.mockClear();
    const before = await admin.query(`SELECT count(*)::int AS n, sum("amountMinor")::int AS s FROM payment WHERE "invoiceId" = $1`, [PAID_BUT_OWING]);

    const r = await svc.rederive(operator, PAID_BUT_OWING);
    expect(r).toMatchObject({ from: "PAID", to: "PARTIALLY_PAID", netPaidMinor: 500, totalMinor: 1_500, notified: 1 });

    const after = await admin.query(`SELECT status FROM invoice WHERE id = $1`, [PAID_BUT_OWING]);
    expect(after.rows[0].status).toBe("PARTIALLY_PAID");
    const money = await admin.query(`SELECT count(*)::int AS n, sum("amountMinor")::int AS s FROM payment WHERE "invoiceId" = $1`, [PAID_BUT_OWING]);
    expect(money.rows[0]).toEqual(before.rows[0]);

    const actions = audit.record.mock.calls.map((c) => [c[0].action, c[0].schoolId]);
    expect(actions).toEqual([
      ["fee.ledger.rederive", S1],
      ["fee.invoice.status.rederive", S1],
    ]);
    expect(notifications.enqueue).toHaveBeenCalledTimes(1);
    expect(notifications.enqueue.mock.calls[0][1]).toMatchObject({ recipientId: BURSAR, type: "OPERATOR_ALERT" });
    expect((await ours()).has(PAID_BUT_OWING)).toBe(false);
  });

  it("refuses a second press, a closed bill and an unknown id — each in its own words", async () => {
    await expect(svc.rederive(operator, PAID_BUT_OWING)).rejects.toThrow(ConflictException);
    await expect(svc.rederive(operator, PAID_BUT_OWING)).rejects.toThrow(/already agrees/);
    await expect(svc.rederive(operator, CANCELLED)).rejects.toThrow(/CANCELLED/);
    await expect(svc.rederive(operator, randomUUID())).rejects.toThrow(NotFoundException);
  });

  it("corrects across tenants: the platform fixes another school's label and audits it THERE", async () => {
    audit.record.mockClear();
    const r = await svc.rederive(operator, SCHOLARSHIP_GONE);
    expect(r).toMatchObject({ from: "PAID", to: "PARTIALLY_PAID", netPaidMinor: 500 });
    expect(audit.record.mock.calls.map((c) => c[0].schoolId)).toEqual([S1, S2]);
  });
});
