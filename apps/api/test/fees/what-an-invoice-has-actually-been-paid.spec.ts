// =============================================================================
// One definition of "paid", and three places that could not express it
// =============================================================================
// `FeesService.paidMinor` has always stated the rule: POSTED payments MINUS
// POSTED refunds; PENDING_APPROVAL and REJECTED never count. Fifteen places
// hand-wrote that reduce — and three used a Prisma `_sum`, which cannot subtract
// a REFUND, so they approximated it two different ways and BOTH understate what
// a family owes:
//
//   where: { status: POSTED, kind: PAYMENT }   refunds EXCLUDED
//   where: { status: POSTED }                  refunds counted POSITIVE
//
// On an invoice of 500 paid 300 and refunded 100 the school is owed 300. The
// first shape says 200, the second says 100. Verified live: the CARD rail, which
// does the reduce properly, asked for exactly NGN 30,000 on a NGN 50,000 invoice
// paid 30,000 and refunded 10,000.
//
// Too LOW is the dangerous direction — it is the number a rail asks a parent
// for, and the number a leaver's transcript decision is taken on.
// =============================================================================

import { netPaidByInvoice, netPaidMinor, netPaidOf } from "../../src/fees/net-paid";

const ROWS = [
  { amountMinor: 300, kind: "PAYMENT" },
  { amountMinor: 100, kind: "REFUND" },
];

describe("what an invoice has actually been paid", () => {
  it("subtracts a refund rather than excluding or adding it", () => {
    expect(netPaidOf(ROWS)).toBe(200);
    // The two shapes that were shipped, for contrast — on a 500 invoice they
    // leave the school short by the refund, and by twice it.
    const excluded = ROWS.filter((r) => r.kind === "PAYMENT").reduce((n, r) => n + r.amountMinor, 0);
    const addedPositive = ROWS.reduce((n, r) => n + r.amountMinor, 0);
    expect(500 - netPaidOf(ROWS)).toBe(300); // the truth
    expect(500 - excluded).toBe(200);
    expect(500 - addedPositive).toBe(100);
  });

  it("asks the database only for POSTED rows", async () => {
    let seen: Record<string, unknown> = {};
    const tx = {
      payment: {
        findMany: async (a: { where: Record<string, unknown> }) => {
          seen = a.where;
          return ROWS;
        },
      },
    };
    await netPaidMinor(tx as never, "inv-1");
    // PENDING_APPROVAL is precisely what maker-checker creates, and it must not
    // move a balance until somebody has approved it.
    expect(seen).toMatchObject({ invoiceId: "inv-1", status: "POSTED" });
  });

  it("nets per invoice when pricing many at once", async () => {
    const tx = {
      payment: {
        findMany: async () => [
          { invoiceId: "a", amountMinor: 300, kind: "PAYMENT" },
          { invoiceId: "a", amountMinor: 100, kind: "REFUND" },
          { invoiceId: "b", amountMinor: 50, kind: "PAYMENT" },
        ],
      },
    };
    const byInvoice = await netPaidByInvoice(tx as never, { invoice: { studentId: "s" } });
    expect(byInvoice.get("a")).toBe(200);
    expect(byInvoice.get("b")).toBe(50);
  });

  it("keeps the POSTED filter even when the caller supplies its own where", async () => {
    let seen: Record<string, unknown> = {};
    const tx = {
      payment: {
        findMany: async (a: { where: Record<string, unknown> }) => {
          seen = a.where;
          return [];
        },
      },
    };
    await netPaidByInvoice(tx as never, { invoice: { studentId: "s" } });
    expect(seen).toMatchObject({ status: "POSTED", invoice: { studentId: "s" } });
  });

  it("a refund alone leaves a NEGATIVE net, not a clamped zero", () => {
    // Clamping here would hide an over-refund from whoever has to reconcile it;
    // the callers clamp the OUTSTANDING, which is a different number.
    expect(netPaidOf([{ amountMinor: 100, kind: "REFUND" }])).toBe(-100);
  });
});
