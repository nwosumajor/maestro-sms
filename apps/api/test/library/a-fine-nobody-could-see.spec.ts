// =============================================================================
// A fine nobody could see, paid into an invoice nobody had issued
// =============================================================================
// Putting library fines on the ledger was done so a school could answer "what
// are we owed in fines, and what have we collected" from the place it keeps
// every other figure. It billed them to a DRAFT invoice, which answers neither.
//
// The fees service states the rule in both directions and the library was on
// the wrong side of it twice:
//
//   "A DRAFT IS NOT A BILL YET, so a family must not be shown one."
//   "Issue the invoice before recording payment."
//
// Reproduced end to end against the running stack, one book seven days late:
//
//   fine 35,000 billed to invoice FINE-…-krbhe          status DRAFT
//   parent's invoice list                                2 invoices, neither the fine
//   cash paid at the desk                                Payment POSTED on the DRAFT
//   invoice afterwards                                   PAID — never ISSUED
//   the school's own figures     invoiced 185,000 / collected 85,000
//                                — containing neither the charge nor the cash
//
// So the charge was invisible to the family, the cash was invisible to finance,
// and an invoice went from DRAFT to PAID without ever being a bill.
//
// The second half is `payFine` posting CONDITIONALLY on finding the charge. A
// miss was silent — fine marked paid, receipt printed, no Payment — and there
// is a loan on the live database in exactly that state, `fineMinor` set with no
// line item, because it predates fines being billed at all.
// =============================================================================

import { LibraryService } from "../../src/library/library.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const LOAN = "7cabe8da-871a-4974-b8da-083677df989d";
const MARKER = `Library fine — loan ${LOAN.slice(0, 8).toUpperCase()}`;

function makeService(opts: {
  invoices?: Array<{ id: string; status: string }>;
  existingLine?: { invoiceId: string } | null;
  loan?: Record<string, unknown>;
}) {
  const created: Array<Record<string, unknown>> = [];
  const payments: Array<Record<string, unknown>> = [];
  const lines: Array<Record<string, unknown>> = [];
  let line = opts.existingLine ?? null;
  const tx = {
    bookLoan: {
      findFirst: jest.fn().mockResolvedValue(
        opts.loan ?? { id: LOAN, borrowerId: "pupil-1", bookId: "b1", fineMinor: 35000, finePaid: false },
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLineItem: {
      findFirst: jest.fn(() => Promise.resolve(line)),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        lines.push(args.data);
        line = { invoiceId: args.data.invoiceId as string };
        return Promise.resolve(args.data);
      }),
    },
    invoice: {
      findFirst: jest.fn(({ where }: { where: { status?: { in?: string[] } } }) => {
        const wanted = where.status?.in ?? [];
        return Promise.resolve((opts.invoices ?? []).find((i) => wanted.includes(i.status)) ?? null);
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: "new-invoice", ...args.data });
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        payments.push(args.data);
        return Promise.resolve(args.data);
      }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }),
    },
    school: { findFirst: jest.fn().mockResolvedValue({ currency: "NGN" }) },
    parentChild: { findMany: jest.fn().mockResolvedValue([{ parentId: "mum-1" }]) },
    libraryBook: { findFirstOrThrow: jest.fn().mockResolvedValue({ title: "SEED Reader 37" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ name: "Demo Student" }) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const svc = new LibraryService(db as never, { record: jest.fn() } as never, { enqueue } as never);
  return { svc, tx, created, payments, lines, enqueue };
}

const librarian: Principal = {
  schoolId: "A",
  userId: "lib-1",
  roles: ["librarian"],
  permissions: ["library.manage"],
};

describe("where a fine is billed", () => {
  it("creates an ISSUED invoice when the borrower has no live debt", async () => {
    // DRAFT is what this used to do, and a DRAFT is not a bill: invisible to
    // the family AND excluded from the school's billable figures.
    const { svc, created } = makeService({ invoices: [], existingLine: null });
    await svc.payFine(librarian, LOAN);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "ISSUED", studentId: "pupil-1" });
  });

  it("attaches to an existing ISSUED invoice rather than opening another", async () => {
    const { svc, created, lines } = makeService({
      invoices: [{ id: "inv-live", status: "ISSUED" }],
      existingLine: null,
    });
    await svc.payFine(librarian, LOAN);
    expect(created).toHaveLength(0);
    expect(lines[0]).toMatchObject({ invoiceId: "inv-live", description: MARKER });
  });

  it("treats PARTIALLY_PAID as a live debt too", async () => {
    const { svc, created, lines } = makeService({
      invoices: [{ id: "inv-part", status: "PARTIALLY_PAID" }],
      existingLine: null,
    });
    await svc.payFine(librarian, LOAN);
    expect(created).toHaveLength(0);
    expect(lines[0]).toMatchObject({ invoiceId: "inv-part" });
  });

  it("never reopens a settled invoice", async () => {
    // Adding a line to a PAID invoice would silently make it underpaid, turning
    // a closed bill back into a debt without anyone deciding to.
    const { svc, created } = makeService({ invoices: [{ id: "inv-paid", status: "PAID" }], existingLine: null });
    await svc.payFine(librarian, LOAN);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "ISSUED" });
  });
});

describe("taking the money", () => {
  it("posts a Payment against the charge", async () => {
    const { svc, payments } = makeService({ existingLine: { invoiceId: "inv-1" } });
    await svc.payFine(librarian, LOAN);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      invoiceId: "inv-1",
      amountMinor: 35000,
      status: "POSTED",
      reference: `FINE-${LOAN.slice(0, 8).toUpperCase()}`,
    });
  });

  it("bills the charge first when the fine was never billed at all", async () => {
    // The live-database case: `fineMinor` set with no line item, from before
    // fines were billed. This used to mark the fine paid, print a receipt and
    // post NOTHING — money over the desk that the ledger never heard about.
    const { svc, payments, lines } = makeService({ invoices: [], existingLine: null });
    const receipt = await svc.payFine(librarian, LOAN);
    expect(lines).toHaveLength(1);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountMinor: 35000 });
    expect(receipt.fineMinor).toBe(35000);
  });

  it("refuses a second payment", async () => {
    // The claim is what enforces it: two callers both reading finePaid=false
    // would otherwise both post.
    const { svc, tx } = makeService({ existingLine: { invoiceId: "inv-1" } });
    (tx.bookLoan.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    await expect(svc.payFine(librarian, LOAN)).rejects.toThrow(/already paid/i);
  });
});

describe("telling the family", () => {
  it("receipts the payer AND their guardians when a fine is paid", async () => {
    // Cash over a desk is the payment least likely to leave the payer with
    // anything in writing, and the fees module receipts every other posted
    // payment. This one went through the same Payment table and told nobody.
    const { svc, enqueue } = makeService({ existingLine: { invoiceId: "inv-1" } });
    await svc.payFine(librarian, LOAN);
    const to = enqueue.mock.calls.map((c) => (c[1] as { recipientId: string }).recipientId);
    expect(to).toEqual(["pupil-1", "mum-1"]);
    expect((enqueue.mock.calls[0][1] as { title: string }).title).toMatch(/paid/i);
  });

  it("names the amount in the invoice's OWN currency", async () => {
    // Money is scaled by the currency: eleven of the catalogued African
    // currencies have no minor unit, so an assumed NGN would print a CFA-franc
    // fine at a hundredth of its value.
    const { svc, enqueue, tx } = makeService({ existingLine: { invoiceId: "inv-1" } });
    (tx.invoice.findFirst as jest.Mock).mockResolvedValue({ currency: "XOF" });
    await svc.payFine(librarian, LOAN);
    const body = (enqueue.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain("35,000");
    expect(body).not.toContain("350.00");
  });

  it("never lets a failed notice undo the payment", async () => {
    // Best-effort and AFTER the transaction: the money is a committed fact by
    // the time anyone is told about it.
    const { svc, enqueue, payments } = makeService({ existingLine: { invoiceId: "inv-1" } });
    enqueue.mockRejectedValue(new Error("smtp down"));
    await expect(svc.payFine(librarian, LOAN)).resolves.toMatchObject({ fineMinor: 35000 });
    expect(payments).toHaveLength(1);
  });
});
