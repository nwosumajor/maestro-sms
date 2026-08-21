// =============================================================================
// A library fine is money the school took
// =============================================================================
// Two things were missing, and both are about the record rather than the rules.
//
// WHEN. `finePaid` is a boolean: it recorded THAT money changed hands and never
// when. The receipt's `paidAt` was `new Date()` at print time, computed and
// thrown away, so the only trace of the date was the audit entry.
//
// AGAIN. `payFine` was the ONLY source of the receipt, and it refuses a second
// call ("Fine already paid"). A librarian who closed the dialog, or a parent
// asking for a copy the next day, had no way to get it back — for money the
// school had already taken.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LibraryService } from "../../src/library/library.service";

const LOAN = "33333333-3333-3333-3333-333333333333";
const librarian = { schoolId: "S", userId: "lib-1", roles: ["librarian"], permissions: ["library.manage"] };
const borrower = { schoolId: "S", userId: "kid-1", roles: ["student"], permissions: [] };
const other = { schoolId: "S", userId: "kid-2", roles: ["student"], permissions: [] };

function makeService(loan: Record<string, unknown> | null, line: { invoiceId: string } | null = { invoiceId: "inv-1" }) {
  const update = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const paymentCreate = jest.fn().mockResolvedValue({});
  const tx = {
    // payFine CLAIMS the settlement with a conditional updateMany now (#252),
    // so the Payment is posted only by the caller that wins it.
    bookLoan: {
      findFirst: jest.fn().mockResolvedValue(loan),
      update,
      updateMany,
    },
    libraryBook: { findFirstOrThrow: jest.fn().mockResolvedValue({ title: "Things Fall Apart" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ name: "Ada Obi" }) },
    // A fine is a charge on the ledger now, so paying one settles a real
    // invoice line rather than flipping a boolean.
    invoiceLineItem: { findFirst: jest.fn().mockResolvedValue(line), create: jest.fn().mockResolvedValue({}) },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ totalMinor: 15000, status: "DRAFT" }),
      create: jest.fn().mockResolvedValue({ id: "inv-1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: paymentCreate, aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 15000 } }) },
    school: { findFirst: jest.fn().mockResolvedValue({ currency: "NGN" }) },
  };
  const db = {
    runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const svc = Object.create(LibraryService.prototype) as LibraryService;
  // Built through the prototype rather than the constructor, so field
  // initialisers never run: the logger and the notifier have to be supplied
  // here or the first thing that uses them dies on `undefined`.
  const enqueue = jest.fn().mockResolvedValue(undefined);
  Object.assign(svc, {
    db,
    audit: { record: jest.fn() },
    notifications: { enqueue },
    logger: { error: jest.fn(), log: jest.fn(), warn: jest.fn() },
  });
  return { svc, tx, update, paymentCreate, updateMany, enqueue };
}

const paidLoan = {
  id: LOAN,
  bookId: "b-1",
  borrowerId: "kid-1",
  status: "RETURNED",
  fineMinor: 15000,
  finePaid: true,
  finePaidAt: new Date("2026-08-01T10:30:00Z"),
};

describe("paying a fine", () => {
  it("records WHEN the money was taken", async () => {
    // The flag and the timestamp are written by the CLAIM now (#252) — the
    // conditional update that decides which caller gets to post the payment —
    // so that is where this reads them from. The property being asserted is
    // unchanged: what was stored is what the receipt states.
    const { svc, updateMany } = makeService({ ...paidLoan, finePaid: false, finePaidAt: null });
    const receipt = await svc.payFine(librarian as never, LOAN);
    const claim = updateMany.mock.calls[0][0];
    expect(claim.data.finePaid).toBe(true);
    expect(claim.data.finePaidAt).toBeInstanceOf(Date);
    // The receipt states the SAME instant that was stored, not a second one
    // computed on the way out.
    expect(receipt.paidAt).toEqual(claim.data.finePaidAt);
  });

  it("POSTS the money to the ledger, not just a boolean", async () => {
    // The whole point of the ledger fix: a fine paid at the desk is countable in
    // the same place as every other payment.
    const { svc, paymentCreate } = makeService({ ...paidLoan, finePaid: false, finePaidAt: null });
    await svc.payFine(librarian as never, LOAN);
    expect(paymentCreate).toHaveBeenCalled();
    const data = paymentCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ invoiceId: "inv-1", amountMinor: 15000, status: "POSTED", kind: "PAYMENT" });
  });

  it("still refuses to take the same fine twice", async () => {
    const { svc } = makeService(paidLoan);
    await expect(svc.payFine(librarian as never, LOAN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("re-printing the receipt", () => {
  it("returns the RECORDED date, not the date of the reprint", async () => {
    // The whole point. A receipt whose date moves every time it is printed is
    // not a receipt.
    const { svc } = makeService(paidLoan);
    const receipt = await svc.fineReceipt(librarian as never, LOAN);
    expect(receipt.paidAt).toEqual(new Date("2026-08-01T10:30:00Z"));
    expect(receipt.fineMinor).toBe(15000);
    expect(receipt.reference).toBe(`FINE-${LOAN.slice(0, 8).toUpperCase()}`);
  });

  it("gives the same reference every time, so two copies are one receipt", async () => {
    const { svc } = makeService(paidLoan);
    const a = await svc.fineReceipt(librarian as never, LOAN);
    const b = await svc.fineReceipt(librarian as never, LOAN);
    expect(a.reference).toBe(b.reference);
  });

  it("CANNOT mark anything paid — it is a read", async () => {
    const { svc, update } = makeService(paidLoan);
    await svc.fineReceipt(librarian as never, LOAN);
    expect(update).not.toHaveBeenCalled();
  });

  it("lets the borrower get their own copy", async () => {
    // They paid it; they are entitled to the receipt without asking staff.
    const { svc } = makeService(paidLoan);
    await expect(svc.fineReceipt(borrower as never, LOAN)).resolves.toMatchObject({ fineMinor: 15000 });
  });

  it("404s somebody else's receipt, rather than 403", async () => {
    // A 403 would confirm the loan exists, and with it that a named pupil owed
    // a fine.
    const { svc } = makeService(paidLoan);
    await expect(svc.fineReceipt(other as never, LOAN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to print a receipt for a fine nobody has paid", async () => {
    const { svc } = makeService({ ...paidLoan, finePaid: false, finePaidAt: null });
    await expect(svc.fineReceipt(librarian as never, LOAN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("the backfill for rows paid before the date was recorded", () => {
  it("uses the return date, and leaves the rest NULL rather than inventing one", async () => {
    // The fine cannot have been paid before the book came back, so the return
    // is the closest true bound. Where even that is unknown the column stays
    // empty: a wrong date on a money record is worse than an absent one, and an
    // absent one is visibly absent.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(__dirname, "../../../../packages/db/prisma/migrations/20261215000000_library_fine_paid_at/migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/SET "finePaidAt" = "returnedAt"/);
    expect(sql).toMatch(/"returnedAt" IS NOT NULL/);
    expect(sql).toMatch(/"finePaidAt" IS NULL/);
  });
});

describe("a fine reaches the ledger", () => {
  // THE GAP THIS CLOSES. `payFine` marked a boolean and printed a receipt, and
  // wrote nothing to the ledger: no invoice line, no Payment. The money was
  // invisible to the finance reports, the receivables ageing, the journal export
  // and reconciliation — a school could not tell you what it was owed in fines
  // or what it had collected, from the place it keeps every other figure.
  //
  // It also made "what does this leaver owe" a lie, because the exit preview and
  // the leavers page read the invoice ledger.
  const src = readFileSync(join(__dirname, "../../src/library/library.service.ts"), "utf8");

  it("is billed as an invoice line when the book comes back late", () => {
    // The call now captures the currency it billed in, so the notice sent to the
    // family can name the amount in the school's own money.
    const ret = src.slice(src.indexOf("async returnLoan"), src.indexOf("private async billFine"));
    expect(ret).toMatch(/if \(fineMinor > 0\) fineCurrency = await this\.billFine/);
  });

  it("is idempotent, so a replay cannot charge the fine twice", () => {
    // Same marker-description guard the late-fee sweep and the hostel rent run
    // use: two lines saying the same thing is what a bursar cannot untangle.
    const bill = src.slice(src.indexOf("private async billFine"), src.indexOf("async payFine"));
    expect(bill).toMatch(/Library fine — loan/);
    // The guard returns the CURRENCY of the charge that already exists rather
    // than bare `return`, so a replay still tells the caller what to announce.
    expect(bill).toMatch(/if \(existing\) \{/);
    expect(bill).toMatch(/Already billed — a replay, not a second fine/);
  });

  it("raises the invoice in the SCHOOL's currency", () => {
    // Settlement REFUSES a charge whose currency differs from the invoice, so a
    // fine raised in the column default could never be paid online.
    const bill = src.slice(src.indexOf("private async billFine"), src.indexOf("async payFine"));
    expect(bill).toMatch(/school\?\.currency \?\? "NGN"/);
  });

  it("posts a real POSTED payment when the fine is paid", () => {
    const pay = src.slice(src.indexOf("async payFine"), src.indexOf("private async settleInvoiceIfPaid"));
    expect(pay).toMatch(/tx\.payment\.create/);
    expect(pay).toMatch(/status: "POSTED"/);
    expect(pay).toMatch(/kind: "PAYMENT"/);
  });

  it("moves the invoice out of DRAFT so receivables stop reporting a settled debt", () => {
    expect(src).toMatch(/settleInvoiceIfPaid/);
    const settle = src.slice(src.indexOf("private async settleInvoiceIfPaid"));
    expect(settle).toMatch(/"PAID"/);
    expect(settle).toMatch(/"PARTIALLY_PAID"/);
  });
});
