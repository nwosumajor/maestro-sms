// =============================================================================
// Money awaiting approval is money committed against the invoice
// =============================================================================
// The overpayment guard read POSTED payments only, and a payment awaiting a
// second signature is not POSTED. So two payments each for the FULL outstanding
// balance both passed the check — neither could see the other — and approving
// both paid the invoice twice.
//
// Not a race. Sequential, deterministic, through the front door. Measured on a
// 5,000-school fleet, on a GBP school where an unset threshold correctly makes
// every payment reviewable:
//
//   invoice 15,000,000, already paid 5,000,000, outstanding 10,000,000
//   record 10,000,000  -> 201, pending
//   record 10,000,000  -> 201, pending      <- the defect
//   approve both       -> paid 25,000,000, balance MINUS 10,000,000, PAID
//
// The invoice DTO has reported `pendingApprovalMinor` all along. The number was
// on the screen; it simply was not in the guard.
//
// TWO guards, because one is not enough. Record-time stops the second payment
// being accepted. Approval-time re-checks, because a payment can sit pending for
// days while an ONLINE payment settles against the same invoice through
// `InvoiceSettlementService` — approving is the moment money lands, so it is the
// moment the balance has to hold. Verified live for both.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const bursar: Principal = { schoolId: "A", userId: "bursar", roles: ["accountant"], permissions: [] };
const head: Principal = { schoolId: "A", userId: "head", roles: ["principal"], permissions: [] };

type Row = { id: string; amountMinor: number; kind: string; status: string; recordedById?: string; invoiceId?: string };

function harness(opts: { totalMinor: number; payments: Row[]; thresholdMinor?: number | null }) {
  const rows = [...opts.payments];
  const invoice = { id: "inv-1", totalMinor: opts.totalMinor, status: "ISSUED", currency: "GBP", studentId: "stu-1" };
  const tx = {
    // HONOURS `where.status`. A double returning the same rows whatever the
    // status asked for cannot tell POSTED from PENDING — which is precisely the
    // distinction this fix turns on.
    payment: {
      findMany: jest.fn(async ({ where }: { where: { status?: string } }) =>
        rows.filter((r) => (where?.status ? r.status === where.status : true)),
      ),
      findFirst: jest.fn(async ({ where }: { where: { id?: string } }) => rows.find((r) => r.id === where?.id) ?? null),
      aggregate: jest.fn(async () => ({
        _sum: { amountMinor: rows.filter((r) => r.status === "POSTED").reduce((n, r) => n + r.amountMinor, 0) },
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...(data as unknown as Row), id: `p${rows.length}` };
        rows.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return { count: 0 };
        r.status = data.status;
        return { count: 1 };
      }),
      update: jest.fn(async () => ({})),
    },
    invoice: {
      findFirst: jest.fn(async () => ({ ...invoice })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...invoice, ...data })),
    },
    school: { findFirst: jest.fn(async () => ({ currency: "GBP", paymentApprovalThresholdMinor: opts.thresholdMinor ?? null })) },
    user: { findFirst: jest.fn(async () => ({ id: "stu-1", name: "A Pupil" })) },
    parentChild: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    invoiceLineItem: { create: jest.fn(), createMany: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => []),
  } as unknown as TenantTx;

  // MODELS THE TRANSACTION, because one of the properties below depends on it.
  // `approvePayment` claims the payment and THEN re-checks the balance, so a
  // refusal must roll the claim back — "nothing half-applied" is only true
  // because the throw aborts the transaction. A double that mutates in place and
  // never rolls back cannot tell that property from its absence.
  const db = {
    runAsTenant: async <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => {
      const snapshot = rows.map((r) => ({ ...r }));
      try {
        return await fn(tx);
      } catch (err) {
        rows.length = 0;
        rows.push(...snapshot);
        throw err;
      }
    },
  };
  const svc = new FeesService(
    db as never,
    { record: jest.fn() } as never,
    { enqueue: jest.fn(), enqueueMany: jest.fn() } as never,
    { isConfigured: () => false, refund: jest.fn() } as never,
    { todayInTx: async () => new Date() } as never,
  );
  return { svc, rows };
}

const posted = (n: number): Row => ({ id: "posted", amountMinor: n, kind: "PAYMENT", status: "POSTED" });

describe("an invoice cannot be committed twice for the same balance", () => {
  it("REFUSES a second payment for a balance already awaiting approval", async () => {
    const { svc } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    // The first takes the whole outstanding 10,000,000 and waits for approval.
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" });
    // The second must not be accepted just because the first has not posted.
    await expect(
      svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("says WHY — that money is queued, not that the invoice is simply full", async () => {
    const { svc } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" });
    await expect(
      svc.recordPayment(bursar, "inv-1", { amountMinor: 1, method: "CASH" }),
    ).rejects.toThrow(/awaiting approval/i);
  });

  it("still accepts a payment that FITS beside what is pending", async () => {
    const { svc } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 4_000_000, method: "CASH" });
    // 5,000,000 posted + 4,000,000 pending leaves 6,000,000 free.
    await expect(
      svc.recordPayment(bursar, "inv-1", { amountMinor: 6_000_000, method: "CASH" }),
    ).resolves.toBeDefined();
  });

  it("RE-CHECKS at approval, because money can land while a payment waits", async () => {
    // A payment for the whole balance is pending; an online payment then settles
    // against the same invoice. Approving would take it past its total.
    const { svc, rows } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    const pending = await svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" });
    rows.push({ id: "online", amountMinor: 5_000_000, kind: "PAYMENT", status: "POSTED" });
    const pendingRow = rows.find((r) => r.status === "PENDING_APPROVAL");
    void pending;
    await expect(svc.approvePayment(head, pendingRow!.id)).rejects.toThrow(/past its total/i);
  });

  it("leaves the payment PENDING when approval is refused — nothing is half-applied", async () => {
    const { svc, rows } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" });
    rows.push({ id: "online", amountMinor: 5_000_000, kind: "PAYMENT", status: "POSTED" });
    const pendingRow = rows.find((r) => r.status === "PENDING_APPROVAL")!;
    await expect(svc.approvePayment(head, pendingRow.id)).rejects.toThrow();
    expect(rows.find((r) => r.id === pendingRow.id)!.status).toBe("PENDING_APPROVAL");
  });

  it("approves normally when the balance still holds", async () => {
    const { svc, rows } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 10_000_000, method: "CASH" });
    const pendingRow = rows.find((r) => r.status === "PENDING_APPROVAL")!;
    await expect(svc.approvePayment(head, pendingRow.id)).resolves.toBeDefined();
  });

  it("bounds a REFUND by what was received, so two pending refunds cannot both take it", async () => {
    const { svc } = harness({ totalMinor: 15_000_000, payments: [posted(5_000_000)] });
    await svc.recordPayment(bursar, "inv-1", { amountMinor: 5_000_000, method: "CASH", kind: "REFUND" });
    await expect(
      svc.recordPayment(bursar, "inv-1", { amountMinor: 5_000_000, method: "CASH", kind: "REFUND" }),
    ).rejects.toThrow(/Refund exceeds/i);
  });
});
