// =============================================================================
// FeesService — money math, invoice lifecycle, scoping, maker-checker
// =============================================================================
// In-memory fakes (no DB / Redis).
// =============================================================================

import { FeesService } from "../../src/fees/fees.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

interface Fakes {
  invoiceRow?: Record<string, unknown> | null;
  /** POSTED payments already on the invoice (drive net paid). */
  posted?: { amountMinor: number; kind: string }[];
  /** The payment returned by payment.findFirst (for approve/reject). */
  pendingPayment?: Record<string, unknown> | null;
  parentLink?: { id: string } | null;
  parentChildMany?: { studentId: string; parentId: string }[];
  studentUser?: { id: string } | null;
}

function makeService(f: Fakes) {
  const createdInvoice = { id: "inv-1", studentId: "stu-1", reference: "INV-X", totalMinor: 10000, currency: "NGN", status: "DRAFT" };
  const tx = {
    feeItem: { create: jest.fn().mockResolvedValue({ id: "fi-1" }), findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue(f.studentUser === undefined ? { id: "stu-1" } : f.studentUser) },
    invoice: {
      create: jest.fn().mockResolvedValue(createdInvoice),
      findFirst: jest.fn().mockResolvedValue(f.invoiceRow === undefined ? null : f.invoiceRow),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...createdInvoice, ...f.invoiceRow, ...data }),
      ),
    },
    invoiceLineItem: { create: jest.fn().mockResolvedValue({ id: "li-1" }) },
    payment: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "pay-1", ...data })),
      findFirst: jest.fn().mockResolvedValue(f.pendingPayment ?? null),
      findMany: jest.fn().mockResolvedValue(f.posted ?? []),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "pay-1", ...data })),
    },
    parentChild: {
      findFirst: jest.fn().mockResolvedValue(f.parentLink ?? null),
      findMany: jest.fn().mockResolvedValue(f.parentChildMany ?? []),
    },
  } as unknown as TenantTx;

  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueue: jest.fn().mockResolvedValue({ id: "n-1" }) };
  const service = new FeesService(db as never, audit as never, notifications as never);
  return { service, tx, audit, notifications };
}

const principal = (roles: string[], userId = "u-1"): Principal => ({
  schoolId: "school-A",
  userId,
  roles,
  permissions: [],
});

describe("FeesService", () => {
  it("computes invoice total from lines (amount * quantity)", async () => {
    const { service, tx } = makeService({});
    await service.createInvoice(principal(["accountant"]), {
      studentId: "stu-1",
      dueDate: "2026-07-01",
      lines: [
        { description: "Tuition", amountMinor: 50000, quantity: 1 },
        { description: "Bus", amountMinor: 2500, quantity: 2 },
      ],
    });
    expect((tx.invoice.create as jest.Mock).mock.calls[0][0].data.totalMinor).toBe(55000);
  });

  it("a small payment posts immediately -> PARTIALLY_PAID, no receipt", async () => {
    const { service, notifications, tx } = makeService({
      invoiceRow: { id: "inv-1", status: "ISSUED", studentId: "stu-1", reference: "INV-X", totalMinor: 10000, currency: "NGN" },
      posted: [],
    });
    const pay = await service.recordPayment(principal(["accountant"]), "inv-1", { amountMinor: 4000, method: "CASH" });
    expect(pay.status).toBe("POSTED");
    expect((tx.invoice.update as jest.Mock).mock.calls[0][0].data.status).toBe("PARTIALLY_PAID");
    expect(notifications.enqueue).not.toHaveBeenCalled();
  });

  it("a final payment -> PAID and sends a receipt", async () => {
    const { service, notifications, tx } = makeService({
      invoiceRow: { id: "inv-1", status: "PARTIALLY_PAID", studentId: "stu-1", reference: "INV-X", totalMinor: 10000, currency: "NGN" },
      posted: [{ amountMinor: 6000, kind: "PAYMENT" }],
      parentChildMany: [{ studentId: "stu-1", parentId: "mum-1" }],
    });
    await service.recordPayment(principal(["accountant"]), "inv-1", { amountMinor: 4000, method: "BANK_TRANSFER" });
    expect((tx.invoice.update as jest.Mock).mock.calls[0][0].data.status).toBe("PAID");
    expect(notifications.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "PAYMENT_RECEIVED" }),
    );
  });

  it("rejects an overpayment beyond the outstanding balance", async () => {
    const { service } = makeService({
      invoiceRow: { id: "inv-1", status: "ISSUED", studentId: "stu-1", totalMinor: 10000, currency: "NGN" },
      posted: [{ amountMinor: 8000, kind: "PAYMENT" }],
    });
    await expect(
      service.recordPayment(principal(["accountant"]), "inv-1", { amountMinor: 5000, method: "CASH" }),
    ).rejects.toThrow(/exceeds/i);
  });

  // --- maker-checker ---
  it("a refund posts as PENDING_APPROVAL and does NOT change the invoice yet", async () => {
    const { service, tx } = makeService({
      invoiceRow: { id: "inv-1", status: "PAID", studentId: "stu-1", totalMinor: 10000, currency: "NGN" },
      posted: [{ amountMinor: 10000, kind: "PAYMENT" }],
    });
    const pay = await service.recordPayment(principal(["accountant"]), "inv-1", { amountMinor: 3000, method: "CASH", kind: "REFUND" });
    expect(pay.status).toBe("PENDING_APPROVAL");
    expect(tx.invoice.update as jest.Mock).not.toHaveBeenCalled();
  });

  it("a large payment posts as PENDING_APPROVAL", async () => {
    const { service } = makeService({
      invoiceRow: { id: "inv-1", status: "ISSUED", studentId: "stu-1", totalMinor: 100_000_000, currency: "NGN" },
      posted: [],
    });
    const pay = await service.recordPayment(principal(["accountant"]), "inv-1", { amountMinor: 6_000_000, method: "BANK_TRANSFER" });
    expect(pay.status).toBe("PENDING_APPROVAL");
  });

  it("the recorder cannot approve their own payment (separation of duties)", async () => {
    const { service } = makeService({
      pendingPayment: { id: "pay-1", status: "PENDING_APPROVAL", recordedById: "u-1", invoiceId: "inv-1", kind: "PAYMENT", amountMinor: 1000 },
    });
    await expect(service.approvePayment(principal(["principal"], "u-1"), "pay-1")).rejects.toThrow(/cannot approve/i);
  });

  it("a different approver posts the payment and updates the invoice", async () => {
    const { service, tx } = makeService({
      pendingPayment: { id: "pay-1", status: "PENDING_APPROVAL", recordedById: "u-2", invoiceId: "inv-1", kind: "PAYMENT", amountMinor: 10000 },
      invoiceRow: { id: "inv-1", status: "ISSUED", studentId: "stu-1", totalMinor: 10000, currency: "NGN", reference: "INV-X" },
      posted: [{ amountMinor: 10000, kind: "PAYMENT" }],
    });
    const res = await service.approvePayment(principal(["principal"], "u-1"), "pay-1");
    expect(res.status).toBe("POSTED");
    expect((tx.payment.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: "POSTED", approvedById: "u-1" });
    expect((tx.invoice.update as jest.Mock).mock.calls[0][0].data.status).toBe("PAID");
  });

  it("a parent reading another family's invoice gets 404", async () => {
    const { service } = makeService({
      invoiceRow: { id: "inv-1", studentId: "not-mine", totalMinor: 10000, status: "ISSUED", dueDate: new Date(), payments: [] },
      parentLink: null,
    });
    await expect(service.getInvoice(principal(["parent"]), "inv-1")).rejects.toThrow(/not found/i);
  });
});
