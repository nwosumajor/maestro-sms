// =============================================================================
// One waiver, approved twice, and an invoice that disagrees with itself
// =============================================================================
// Swept for the read-then-write shape found in the library (#250) — a rule
// enforced by a `findFirst` and an `if`, with the write that depends on it in a
// separate statement. 59 methods have it; most are games and forums where a
// double execution costs nothing. This one moves money.
//
// `decideAdjustment` approves a discount or waiver: it posts a NEGATIVE line
// item and lowers the invoice total. Both the "already decided" guard and the
// total are reads, at READ COMMITTED (no isolationLevel is set anywhere). Two
// approvals of the SAME adjustment therefore both pass the guard, both post a
// line item — and both compute `newTotal = inv.totalMinor - amount` from the
// SAME stale figure, so both write the same header.
//
// Proven by interleaving the service's own statements in two sessions, on a
// ₦100,000 invoice with one ₦50,000 waiver:
//
//     header_says_owed | line_items_say | waiver_lines
//              5000000 |              0 |            2
//
// The invoice's own lines say the family owes nothing. The header — what the
// balance, the receivables ageing and the journal export read — says ₦50,000.
// Nothing ever recomputes a total from its lines, so it stays wrong.
//
// Two separate faults, and the fix needs both:
//   1. CLAIM the approval, so only one caller posts anything.
//   2. DECREMENT the total instead of assigning one computed earlier — the
//      claim says nothing about two DIFFERENT adjustments on one invoice, which
//      would both start from the same figure and lose one of the two.
// =============================================================================

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { notificationsStub } from "../support/notifications-stub";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FeeOpsService } from "../../src/fees/fee-ops.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const approver: Principal = {
  schoolId: "S",
  userId: "u-principal",
  roles: ["principal"],
  permissions: ["fee.approve", "fee.manage"],
};

function makeService(adj: { status: string; requestedById: string; amountMinor: number }) {
  const state = { ...adj, id: "adj-1", invoiceId: "inv-1", kind: "WAIVER", reason: "Hardship" };
  const invoice = { totalMinor: 10_000_000, studentId: "s-1", reference: "INV-1", currency: "NGN" };
  const lineItems: number[] = [];
  const tx = {
    invoiceAdjustment: {
      findFirst: jest.fn(async () => ({ ...state })),
      findFirstOrThrow: jest.fn(async () => ({ ...state })),
      updateMany: jest.fn(async (a: { where: { status: string }; data: { status: string } }) => {
        if (state.status !== a.where.status) return { count: 0 };
        state.status = a.data.status;
        return { count: 1 };
      }),
      update: jest.fn(async (a: { data: { status: string } }) => {
        state.status = a.data.status;
        return { ...state };
      }),
    },
    invoice: {
      findFirst: jest.fn(async () => ({ ...invoice })),
      update: jest.fn(async (a: { data: { totalMinor?: { decrement: number } } }) => {
        if (a.data.totalMinor?.decrement) invoice.totalMinor -= a.data.totalMinor.decrement;
        return { totalMinor: invoice.totalMinor };
      }),
    },
    invoiceLineItem: {
      create: jest.fn(async (a: { data: { amountMinor: number } }) => {
        lineItems.push(a.data.amountMinor);
        return {};
      }),
    },
    payment: { findMany: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: { amountMinor: 0 } })) },
    user: { findFirst: jest.fn(async () => ({ id: "s-1", name: "A Pupil" })), findMany: jest.fn(async () => []) },
    parentChild: { findMany: jest.fn(async () => []) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new FeeOpsService(
    db as never,
    { record: jest.fn() } as never,
    notificationsStub() as never,
    {} as never, // privileged client — unused on this path
    {} as never, // FeesService — unused on this path
  );
  jest.spyOn(svc as unknown as { paidMinor: () => unknown }, "paidMinor").mockResolvedValue(0 as never);
  jest
    .spyOn(svc as unknown as { toAdjustmentDto: () => unknown }, "toAdjustmentDto")
    .mockImplementation(((r: { id: string }) => ({ id: r.id })) as never);
  return { svc, invoice, lineItems, state };
}

const PENDING = { status: "PENDING_APPROVAL", requestedById: "u-bursar", amountMinor: 5_000_000 };

describe("approving one waiver twice", () => {
  it("posts exactly one negative line item", async () => {
    const { svc, lineItems } = makeService(PENDING);
    await svc.decideAdjustment(approver, "adj-1", true);
    await expect(svc.decideAdjustment(approver, "adj-1", true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(lineItems).toEqual([-5_000_000]);
  });

  it("leaves the header total and the line items agreeing", async () => {
    // The actual damage: 100,000 invoice, one 50,000 waiver, two approvals ->
    // header said 50,000 owed while the lines summed to 0.
    const { svc, invoice, lineItems } = makeService(PENDING);
    await svc.decideAdjustment(approver, "adj-1", true);
    await expect(svc.decideAdjustment(approver, "adj-1", true)).rejects.toThrow();
    const linesSum = 10_000_000 + lineItems.reduce((a, b) => a + b, 0);
    expect(invoice.totalMinor).toBe(linesSum);
    expect(invoice.totalMinor).toBe(5_000_000);
  });

  it("does not touch the invoice at all when the claim is lost", async () => {
    const { svc, invoice, lineItems } = makeService({ ...PENDING, status: "APPROVED" });
    await expect(svc.decideAdjustment(approver, "adj-1", true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(invoice.totalMinor).toBe(10_000_000);
    expect(lineItems).toEqual([]);
  });

  it("still enforces separation of duties", async () => {
    // The requester can never approve their own discount — the claim must not
    // have moved this check after the write.
    const { svc, lineItems } = makeService({ ...PENDING, requestedById: approver.userId });
    await expect(svc.decideAdjustment(approver, "adj-1", true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(lineItems).toEqual([]);
  });

  it("approves normally the first time", async () => {
    const { svc, invoice, state } = makeService(PENDING);
    await svc.decideAdjustment(approver, "adj-1", true);
    expect(state.status).toBe("APPROVED");
    expect(invoice.totalMinor).toBe(5_000_000);
  });
});

describe("two DIFFERENT adjustments on one invoice", () => {
  it("both come off the total — the arithmetic is the database's", async () => {
    // A claim on each adjustment says nothing about this: assigning
    // `inv.totalMinor - amount` from a figure read earlier loses one of them.
    const { svc, invoice } = makeService(PENDING);
    await svc.decideAdjustment(approver, "adj-1", true);
    const second = makeService({ ...PENDING, amountMinor: 2_000_000 });
    // Same invoice object semantics: decrementing, not assigning.
    second.invoice.totalMinor = invoice.totalMinor;
    await second.svc.decideAdjustment(approver, "adj-1", true);
    expect(second.invoice.totalMinor).toBe(3_000_000);
  });
});

describe("the shape, so it is not undone", () => {
  const SRC = readFileSync(join(__dirname, "../../src/fees/fee-ops.service.ts"), "utf8");
  const body = SRC.slice(SRC.indexOf("async decideAdjustment"), SRC.indexOf("async decideRefund") + 1 || undefined);

  it("claims the approval with a conditional update", () => {
    expect(body).toMatch(/updateMany\(\{[\s\S]*?status: "PENDING_APPROVAL"/);
  });

  it("posts nothing before the claim", () => {
    expect(body.indexOf("claimed.count === 0")).toBeLessThan(body.indexOf("invoiceLineItem.create"));
  });

  it("decrements the total rather than assigning a figure read earlier", () => {
    expect(body).toMatch(/totalMinor: \{ decrement: row\.amountMinor \}/);
    expect(body).not.toMatch(/totalMinor: newTotal/);
  });
});
