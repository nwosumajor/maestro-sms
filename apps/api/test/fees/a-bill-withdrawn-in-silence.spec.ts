/**
 * A bill withdrawn is withdrawn out loud.
 *
 * Issuing an invoice emails the guardians "Invoice X for Y is due on Z".
 * Cancelling it told them nothing, so the family's last word was that they owed
 * money the school had since withdrawn. Measured live on the running stack:
 * the invoice read CANCELLED and the family received zero notices.
 *
 * Paying a cancelled invoice is already refused, so a parent acting on the
 * message they DO have meets a refusal with no explanation — the message and
 * the system disagreeing about whether money is owed.
 *
 * Third instance of this class here, after a withdrawn duty and a retracted bus
 * boarding, and the second on a notice a family acts on.
 */
import { FeesService } from "../../src/fees/fees.service";

function makeService(status: string) {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  // `enqueueMany` is on every real NotificationService; it fans into the same
  // spy so the assertions below still ask what the family was TOLD.
  const enqueueMany = jest.fn((actor: unknown, to: string[], input: Record<string, unknown>) => {
    // The real enqueueMany ISOLATES per-recipient failures and reports counts;
    // a fan that let one rejection escape would crash the worker instead.
    let failed = 0;
    for (const recipientId of to) {
      try { const r = enqueue(actor, { ...input, recipientId }); if (r?.catch) r.catch(() => { failed += 1; }); }
      catch { failed += 1; }
    }
    return Promise.resolve({ created: to.length - failed, failed });
  });
  const invoice = {
    id: "inv-1", reference: "INV-1", status,
    studentId: "stu-1", totalMinor: 5000000, currency: "NGN",
  };
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(invoice),
      update: jest.fn().mockResolvedValue({ ...invoice, status: "CANCELLED" }),
    },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "mum-1" }]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = Object.create(FeesService.prototype) as FeesService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    db: { runAsTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    notifications: { enqueue, enqueueMany },
    logger: { error: jest.fn() },
    log: jest.fn().mockResolvedValue(undefined),
    ctx: () => ({ schoolId: "sch-1", userId: "staff-1" }),
  });
  return { svc, enqueue };
}

const P = { schoolId: "sch-1", userId: "staff-1" } as never;

describe("a bill withdrawn in silence", () => {
  it("tells the family when an issued invoice is cancelled", async () => {
    const { svc, enqueue } = makeService("ISSUED");
    await svc.cancelInvoice(P, "inv-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].title).toBe("Invoice cancelled");
    expect(enqueue.mock.calls[0][1].body).toMatch(/no longer due/);
  });

  it("tells them for a part-paid invoice too, without promising an outcome", async () => {
    // A part-paid invoice can be cancelled. Whether the money already paid
    // becomes a credit or a refund is decided elsewhere, so the message must not
    // state one — it points them at the office instead.
    const { svc, enqueue } = makeService("PARTIALLY_PAID");
    await svc.cancelInvoice(P, "inv-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    const body = enqueue.mock.calls[0][1].body as string;
    expect(body).toMatch(/already paid it, please contact the school office/i);
    expect(body).not.toMatch(/refund(ed)?\b/i);
  });

  it("stays silent for a DRAFT, which the family was never told about", async () => {
    // Issuing is what announces a bill. A draft is where a bursar assembles one;
    // "your invoice is cancelled" for a bill they never heard of would be the
    // first they knew of any of it.
    const { svc, enqueue } = makeService("DRAFT");
    await svc.cancelInvoice(P, "inv-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not withdraw the same bill twice", async () => {
    // Cancelling is not blocked on an already-CANCELLED invoice, so the notice
    // keys on the TRANSITION, not the outcome. Pressing Cancel twice sent two
    // identical withdrawals — found by a live probe re-running, which is the
    // same duplicate-alert defect the register beside it was just fixed for.
    const { svc, enqueue } = makeService("CANCELLED");
    await svc.cancelInvoice(P, "inv-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rides the essential invoice type so it cannot be muted", async () => {
    // A family that switched billing mail off would otherwise keep the demand
    // and never receive the cancellation.
    const { svc, enqueue } = makeService("ISSUED");
    await svc.cancelInvoice(P, "inv-1");
    expect(enqueue.mock.calls[0][1].type).toBe("INVOICE_ISSUED");
  });

  it("still refuses to cancel a paid invoice", async () => {
    // Magnitude: the cases above would pass against a method that did nothing.
    const { svc, enqueue } = makeService("PAID");
    await expect(svc.cancelInvoice(P, "inv-1")).rejects.toThrow(/paid invoice/i);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
