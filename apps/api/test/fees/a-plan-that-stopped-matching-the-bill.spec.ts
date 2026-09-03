// =============================================================================
// A payment plan that stopped matching the bill
// =============================================================================
// `setPlan` refuses tranches that do not sum EXACTLY to the invoice total, and
// its comment says why: "a plan that doesn't cover the bill is a trap". That is
// checked ONCE, when the plan is written. THREE live paths move an invoice
// afterwards and none re-checked it:
//
//   an approved DISCOUNT / WAIVER  -> negative line item, total DECREMENTED
//   the late-fee sweep             -> positive line item, total INCREMENTED
//   a library fine                 -> positive line item, total INCREMENTED
//
// Found by reconciling the demo database rather than reading the code: one
// invoice's instalments summed to 100,000 against line items of 80,000, and its
// history showed a "Discount: sibling discount" line written 271ms after the
// plan.
//
// Driven live on a fresh invoice: 100,000 with a 50,000 + 50,000 plan, then an
// approved 40,000 discount. The invoice fell to 60,000, the family paid 60,000
// in full, the invoice read PAID with a zero balance —
//
//     tranches: [{seq:1, PAID}, {seq:2, amt:50000, state:"DUE"}]
//
// — so a family that had settled their bill was shown an outstanding
// instalment. After: both PAID, coversInvoice false, both totals reported.
//
// THE TWO DIRECTIONS ARE HANDLED DIFFERENTLY AND DELIBERATELY. Capping a
// tranche's cumulative at what is actually owed fixes the discount case,
// because money no longer owed cannot be outstanding. The late-fee case is
// REPORTED, never silently absorbed: growing the last tranche would invent a
// payment schedule the family never agreed to.
// =============================================================================

import { PaymentPlansService } from "../../src/fees/payment-plans.service";
import { notificationsStub } from "../support/notifications-stub";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

function make(opts: {
  invoiceTotal: number;
  tranches: Array<{ seq: number; amountMinor: number; dueDate: string }>;
  payments?: Array<{ amountMinor: number; kind: string }>;
}) {
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ studentId: "stu-1", totalMinor: opts.invoiceTotal }),
    },
    invoiceInstallment: {
      findMany: jest.fn().mockResolvedValue(
        opts.tranches.map((t) => ({ seq: t.seq, amountMinor: t.amountMinor, dueDate: new Date(t.dueDate) })),
      ),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue(
        (opts.payments ?? []).map((p) => ({ amountMinor: p.amountMinor, kind: p.kind })),
      ),
    },
    parentChild: { findFirst: jest.fn().mockResolvedValue(null) },
  } as unknown as TenantTx;
  const db = {
    runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // A fixed school day well before every due date below, so nothing is OVERDUE
  // for a reason this test is not about.
  const region = {
    todayInTx: jest.fn(async () => new Date("2026-09-01T00:00:00.000Z")),
    forSchool: jest.fn(async () => ({ currency: "NGN", timezone: "UTC" })),
  };
  // Constructor order matters and the region is FIFTH: db, audit, notifications,
  // paystack, region. A fixture that guesses it wires the region into the
  // notifier and every call throws — the same trap this repo records for the
  // transport service's six arguments.
  const notifications = notificationsStub();
  const paystack = {};
  return new PaymentPlansService(
    db as never, audit as never, notifications as never, paystack as never, region as never,
  );
}

const staff: Principal = { schoolId: "A", userId: "s1", roles: ["school_admin"], permissions: [] };
const PLAN = [
  { seq: 1, amountMinor: 50_000, dueDate: "2026-10-15" },
  { seq: 2, amountMinor: 50_000, dueDate: "2026-11-15" },
];

describe("a plan whose invoice was discounted after it was written", () => {
  it("does not show an instalment DUE on a bill that is fully settled", async () => {
    // The live defect, exactly: total 100,000 -> 60,000 by an approved
    // discount, family pays the whole 60,000.
    const svc = make({ invoiceTotal: 60_000, tranches: PLAN, payments: [{ amountMinor: 60_000, kind: "PAYMENT" }] });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.tranches.map((t) => t.state)).toEqual(["PAID", "PAID"]);
  });

  it("says the plan no longer matches, and reports both figures", async () => {
    const svc = make({ invoiceTotal: 60_000, tranches: PLAN });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.coversInvoice).toBe(false);
    expect(plan.invoiceTotalMinor).toBe(60_000);
    expect(plan.plannedTotalMinor).toBe(100_000);
  });

  it("still reports a partly-paid plan honestly", async () => {
    // 30,000 of a 60,000 bill: the first tranche is not yet covered.
    const svc = make({ invoiceTotal: 60_000, tranches: PLAN, payments: [{ amountMinor: 30_000, kind: "PAYMENT" }] });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.tranches.map((t) => t.state)).toEqual(["DUE", "UPCOMING"]);
  });
});

describe("a plan whose invoice GREW after it was written", () => {
  // The late-fee sweep and a library fine both `increment` totalMinor.
  it("is reported, never silently absorbed into the last tranche", async () => {
    const svc = make({ invoiceTotal: 120_000, tranches: PLAN });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.coversInvoice).toBe(false);
    expect(plan.plannedTotalMinor).toBe(100_000);
    expect(plan.invoiceTotalMinor).toBe(120_000);
    // The tranches themselves are untouched: inventing a schedule the family
    // never agreed to would be a worse answer than saying the plan is short.
    expect(plan.tranches.map((t) => t.amountMinor)).toEqual([50_000, 50_000]);
  });

  it("does not mark the plan complete while the bill is short", async () => {
    // Paying every tranche in full leaves 20,000 owed. The cap must not fire in
    // this direction — too low is the dangerous one.
    const svc = make({ invoiceTotal: 120_000, tranches: PLAN, payments: [{ amountMinor: 100_000, kind: "PAYMENT" }] });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.tranches.map((t) => t.state)).toEqual(["PAID", "PAID"]);
    expect(plan.coversInvoice).toBe(false); // and THIS is what the screen says
  });
});

describe("an untouched plan", () => {
  it("covers its invoice and says so", async () => {
    const svc = make({ invoiceTotal: 100_000, tranches: PLAN });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.coversInvoice).toBe(true);
    expect(plan.tranches.map((t) => t.state)).toEqual(["DUE", "UPCOMING"]);
  });

  it("counts a REFUND against what has been paid", async () => {
    // The shared net-paid definition, which this service now uses instead of
    // its own private copy of the same reduce.
    const svc = make({
      invoiceTotal: 100_000,
      tranches: PLAN,
      payments: [{ amountMinor: 60_000, kind: "PAYMENT" }, { amountMinor: 20_000, kind: "REFUND" }],
    });
    const plan = await svc.getPlan(staff, "inv-1");
    expect(plan.tranches.map((t) => t.state)).toEqual(["DUE", "UPCOMING"]);
  });
});
