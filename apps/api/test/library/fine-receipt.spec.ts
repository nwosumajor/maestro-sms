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

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LibraryService } from "../../src/library/library.service";

const LOAN = "33333333-3333-3333-3333-333333333333";
const librarian = { schoolId: "S", userId: "lib-1", roles: ["librarian"], permissions: ["library.manage"] };
const borrower = { schoolId: "S", userId: "kid-1", roles: ["student"], permissions: [] };
const other = { schoolId: "S", userId: "kid-2", roles: ["student"], permissions: [] };

function makeService(loan: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    bookLoan: { findFirst: jest.fn().mockResolvedValue(loan), update },
    libraryBook: { findFirstOrThrow: jest.fn().mockResolvedValue({ title: "Things Fall Apart" }) },
    user: { findFirst: jest.fn().mockResolvedValue({ name: "Ada Obi" }) },
  };
  const db = {
    runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
    runAsTenantReadOnly: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn(tx),
  };
  const svc = Object.create(LibraryService.prototype) as LibraryService;
  Object.assign(svc, { db, audit: { record: jest.fn() } });
  return { svc, tx, update };
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
    const { svc, update } = makeService({ ...paidLoan, finePaid: false, finePaidAt: null });
    const receipt = await svc.payFine(librarian as never, LOAN);
    expect(update.mock.calls[0][0].data.finePaid).toBe(true);
    expect(update.mock.calls[0][0].data.finePaidAt).toBeInstanceOf(Date);
    // The receipt states the SAME instant that was stored, not a second one
    // computed on the way out.
    expect(receipt.paidAt).toEqual(update.mock.calls[0][0].data.finePaidAt);
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
