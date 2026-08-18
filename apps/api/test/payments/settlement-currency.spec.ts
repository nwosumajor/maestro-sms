// =============================================================================
// Settlement — one currency guard, covering every rail at once
// =============================================================================
// `InvoiceSettlementService.applyOnlinePayment` is the ONE place an online
// payment posts: the Paystack webhook, the Stripe webhook, both verify-on-return
// paths, dedicated-account transfers, mobile money and the reconciliation sweep
// all funnel through it. So it is also the one place a currency check covers
// every rail — including rails nobody has written yet.
//
// The bug it exists for: a rail charges in ITS OWN account currency when nobody
// names one. An NGN 5,000 charge posted against a GHS 5,000 invoice marked that
// invoice PAID while the school received about a tenth of the money. Refusing
// leaves the invoice OPEN and the payment unposted — recoverable. Posting it is
// not, because nothing downstream ever revisits a settled invoice.
// =============================================================================

import { InvoiceSettlementService } from "../../src/fees/settlement.service";
import type { TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const SCHOOL = "s-1";

function makeService(invoiceCurrency = "GHS") {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ status: "ISSUED",
        id: "inv-1",
        currency: invoiceCurrency,
        totalMinor: 500_000,
        studentId: "st-1",
        createdById: "u-admin",
        reference: "INV-001",
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
      findMany: jest.fn().mockResolvedValue([{ amountMinor: 500_000, kind: "PAYMENT" }]),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    // Settlement reads the school's subaccount to record whether the charge
    // landed in the school's bank or the platform's — see held-funds.spec.ts.
    // A registered bank here keeps these cases about currency and nothing else.
    school: { findFirst: jest.fn().mockResolvedValue({ paystackSubaccountCode: "ACCT_test" }) },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const svc = new InvoiceSettlementService(db as never, audit as never, notifications as never);
  return { svc, tx, created, notifications };
}

const base = {
  schoolId: SCHOOL,
  invoiceId: "inv-1",
  creditMinor: 500_000,
  chargedMinor: 500_000,
  reference: "PSK-REF-1",
  note: "Online (Paystack)",
};

describe("currency guard", () => {
  it("REFUSES a charge in a different currency from the invoice", async () => {
    // THE case. GHS 5,000 invoice, NGN 5,000 charge — same number, a tenth of the
    // money. Before the guard this posted and marked the invoice PAID.
    const { svc, created, tx } = makeService("GHS");
    await expect(svc.applyOnlinePayment({ ...base, currency: "NGN" })).resolves.toBe("currency_mismatch");
    expect(created).toHaveLength(0);
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("leaves the invoice OPEN and sends no receipt when it refuses", async () => {
    // A receipt for a payment that was not posted is worse than silence: the payer
    // stops chasing it.
    const { svc, notifications, tx } = makeService("GHS");
    await svc.applyOnlinePayment({ ...base, currency: "NGN" });
    expect(notifications.enqueue).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("posts normally when the currencies agree", async () => {
    const { svc, created } = makeService("GHS");
    await expect(svc.applyOnlinePayment({ ...base, currency: "GHS" })).resolves.toBe("posted");
    expect(created).toHaveLength(1);
    expect(created[0].amountMinor).toBe(500_000);
  });

  it("is CASE-SENSITIVE about nothing else — callers normalise to upper", async () => {
    // Stripe reports "usd" lower-case and the invoice stores "USD". The gateway
    // adapters uppercase at the boundary; if one ever stops, this fails loudly
    // here rather than silently rejecting every Stripe settlement in production.
    const { svc } = makeService("USD");
    await expect(svc.applyOnlinePayment({ ...base, currency: "usd" })).resolves.toBe("currency_mismatch");
    await expect(svc.applyOnlinePayment({ ...base, currency: "USD" })).resolves.toBe("posted");
  });

  it("checks currency BEFORE idempotency, so a mismatch is never masked as a duplicate", async () => {
    // Ordering matters: if the dedup ran first, a retried bad-currency charge
    // would report "duplicate" and look handled.
    const { svc, tx } = makeService("GHS");
    (tx.payment.findFirst as jest.Mock).mockResolvedValue({ id: "existing" });
    await expect(svc.applyOnlinePayment({ ...base, currency: "NGN" })).resolves.toBe("currency_mismatch");
  });

  it("still reports a missing invoice as such, not as a mismatch", async () => {
    const { svc, tx } = makeService("GHS");
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.applyOnlinePayment({ ...base, currency: "NGN" })).resolves.toBe("invoice_missing");
  });
});

describe("receipt money formatting", () => {
  it("does not divide a ZERO-DECIMAL currency by 100", async () => {
    // The receipt formatter hard-coded `minor / 100` under an en-NG locale, so a
    // CFA-franc school's receipt showed a HUNDREDTH of the real balance — the same
    // divide-by-100 bug the currency work removed platform-wide, still live on the
    // one path every payer actually reads.
    const { svc, tx, notifications } = makeService("XOF");
    (tx.payment.findMany as jest.Mock).mockResolvedValue([{ amountMinor: 200_000, kind: "PAYMENT" }]);
    (tx.parentChild.findMany as jest.Mock).mockResolvedValue([{ parentId: "p-1" }]);
    await svc.applyOnlinePayment({ ...base, currency: "XOF", creditMinor: 200_000 });

    // enqueue(ctx, notification) — the body is the SECOND argument.
    const bodies = (notifications.enqueue as jest.Mock).mock.calls.map((c) => JSON.stringify(c));
    const withBalance = bodies.filter((b) => b.includes("Outstanding balance"));
    expect(withBalance.length).toBeGreaterThan(0);
    // 500,000 total less 200,000 paid = 300,000 CFA francs — NOT 3,000.
    expect(withBalance.some((b) => b.includes("300,000") || b.includes("300 000"))).toBe(true);
    expect(withBalance.some((b) => b.includes("3,000.00"))).toBe(false);
  });
});
