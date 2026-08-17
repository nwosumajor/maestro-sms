// =============================================================================
// LibraryService — issue/availability/fine/self-scope unit tests
// =============================================================================

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { LibraryService } from "../../src/library/library.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const librarian: Principal = { schoolId: "A", userId: "lib", roles: ["school_admin"], permissions: ["library.manage", "library.borrow"] };
const student: Principal = { schoolId: "A", userId: "stu1", roles: ["student"], permissions: ["library.borrow"] };

const DAY = 24 * 60 * 60 * 1000;

function makeTx(over: Record<string, unknown> = {}) {
  const calls = { loanCreate: 0, bookDec: 0, bookInc: 0 };
  const tx = {
    libraryBook: (() => {
      const book = (over.book ?? { id: "b1", availableCopies: 2, totalCopies: 3, barcode: "BC1", title: "Book" }) as {
        availableCopies: number;
      };
      return {
        findFirst: jest.fn().mockResolvedValue(book),
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: "b1", title: "Book", barcode: "BC1" }),
        findMany: jest.fn().mockResolvedValue([{ totalCopies: 3, availableCopies: 2 }]),
        create: jest.fn().mockResolvedValue({ id: "b1" }),
        // Atomic copy-claim: the real DB decrements only when availableCopies>=1.
        // Model that here so the count reflects whether a copy was free.
        updateMany: jest.fn((a: { where: { availableCopies?: { gte?: number } }; data: { availableCopies?: { decrement?: number } } }) => {
          const needs = a.where.availableCopies?.gte ?? 0;
          if (a.data.availableCopies?.decrement && book.availableCopies >= needs) {
            calls.bookDec++;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        }),
        update: jest.fn((a: { data: { availableCopies?: { decrement?: number; increment?: number } } }) => {
          if (a.data.availableCopies?.decrement) calls.bookDec++;
          if (a.data.availableCopies?.increment) calls.bookInc++;
          return Promise.resolve({});
        }),
      };
    })(),
    bookLoan: {
      findFirst: jest.fn().mockResolvedValue(over.loan ?? null),
      findFirstOrThrow: jest.fn().mockResolvedValue(over.loanRow ?? { id: "l1", bookId: "b1", borrowerId: "stu1", status: "ISSUED", issuedAt: new Date(), dueAt: new Date(Date.now() + 14 * DAY), returnedAt: null, renewedCount: 0, fineMinor: 0, finePaid: false }),
      create: jest.fn(() => { calls.loanCreate++; return Promise.resolve({ id: "l1" }); }),
      update: jest.fn().mockResolvedValue({}),
      // returnLoan/renew CLAIM the row with a conditional updateMany now (#250),
      // so the write only lands while the loan is still ISSUED.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }) },
    // An overdue fine is now a CHARGE on the ledger, not just a number on the
    // loan row — returning a late book raises an invoice line for it. Without
    // these the fine would still be computed and would reach nobody's account.
    invoiceLineItem: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "inv-1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { create: jest.fn().mockResolvedValue({}), aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }) },
    school: { findFirst: jest.fn().mockResolvedValue({ currency: "NGN" }) },
  } as unknown as TenantTx;
  return { tx, calls };
}

function svc(tx: TenantTx) {
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return new LibraryService(db as never, audit as never);
}

describe("LibraryService", () => {
  it("issues a copy and decrements availability", async () => {
    const { tx, calls } = makeTx();
    const dto = await svc(tx).issue(librarian, { bookId: "b1", borrowerId: "stu1" });
    expect(dto.id).toBe("l1");
    expect(calls.loanCreate).toBe(1);
    expect(calls.bookDec).toBe(1);
  });

  it("refuses to issue when no copies are available", async () => {
    const { tx } = makeTx({ book: { id: "b1", availableCopies: 0, totalCopies: 1 } });
    await expect(svc(tx).issue(librarian, { bookId: "b1", borrowerId: "stu1" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a student cannot issue a book to someone else", async () => {
    const { tx } = makeTx();
    await expect(svc(tx).issue(student, { bookId: "b1", borrowerId: "other" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("computes an overdue fine on return (5 days late -> 25000)", async () => {
    const overdueLoan = { id: "l1", bookId: "b1", borrowerId: "stu1", status: "ISSUED", dueAt: new Date(Date.now() - 5 * DAY) };
    const { tx } = makeTx({ loan: overdueLoan, loanRow: { id: "l1", bookId: "b1", borrowerId: "stu1", status: "RETURNED", issuedAt: new Date(), dueAt: overdueLoan.dueAt, returnedAt: new Date(), renewedCount: 0, fineMinor: 25000, finePaid: false } });
    const dto = await svc(tx).returnLoan(librarian, "l1");
    expect(dto.fineMinor).toBe(25000);
  });

  it("a student cannot return a loan at all — theirs or anyone's", async () => {
    // Stronger than the rule this replaces. A return records that the book is
    // physically back on the shelf, so it is the library's to record; a pupil
    // could otherwise stop their own fine and keep the book. See
    // return-is-a-physical-fact.spec.ts. The refusal is identical whichever loan
    // id is passed, so it still discloses nothing about what exists.
    const { tx } = makeTx({ loan: { id: "l1", bookId: "b1", borrowerId: "someone-else", status: "ISSUED", dueAt: new Date() } });
    await expect(svc(tx).returnLoan(student, "l1")).rejects.toThrow(/library desk/i);
    const own = makeTx({ loan: { id: "l1", bookId: "b1", borrowerId: student.userId, status: "ISSUED", dueAt: new Date() } });
    await expect(svc(own.tx).returnLoan(student, "l1")).rejects.toThrow(/library desk/i);
  });

  it("listLoans batches book + borrower lookups (no per-loan N+1) and maps them", async () => {
    const now = Date.now();
    const loans = [
      { id: "l1", bookId: "b1", borrowerId: "u1", status: "ISSUED", issuedAt: new Date(now), dueAt: new Date(now - DAY), returnedAt: null, renewedCount: 0, fineMinor: 0, finePaid: false },
      { id: "l2", bookId: "b2", borrowerId: "u2", status: "RETURNED", issuedAt: new Date(now), dueAt: new Date(now + DAY), returnedAt: new Date(now), renewedCount: 1, fineMinor: 0, finePaid: false },
      { id: "l3", bookId: "b1", borrowerId: "u1", status: "ISSUED", issuedAt: new Date(now), dueAt: new Date(now + DAY), returnedAt: null, renewedCount: 0, fineMinor: 0, finePaid: false },
    ];
    const bookFindMany = jest.fn().mockResolvedValue([
      { id: "b1", title: "Algebra", barcode: "BC1" },
      { id: "b2", title: "History", barcode: "BC2" },
    ]);
    const userFindMany = jest.fn().mockResolvedValue([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Bola" },
    ]);
    const loanFindFirstOrThrow = jest.fn(); // must NOT be used (that was the N+1)
    const tx = {
      bookLoan: { findMany: jest.fn().mockResolvedValue(loans), findFirstOrThrow: loanFindFirstOrThrow },
      libraryBook: { findMany: bookFindMany },
      user: { findMany: userFindMany },
    } as unknown as TenantTx;

    const dtos = await svc(tx).listLoans(librarian, {});
    expect(dtos.map((d) => d.bookTitle)).toEqual(["Algebra", "History", "Algebra"]);
    expect(dtos.map((d) => d.borrowerName)).toEqual(["Ada", "Bola", "Ada"]);
    expect(dtos[0].overdue).toBe(true); // l1 is issued + past due
    expect(dtos[1].overdue).toBe(false); // returned
    // Batched: exactly ONE query for books and ONE for borrowers, regardless of
    // loan count — and the per-loan re-fetch path (loanDto) is never taken.
    expect(bookFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(loanFindFirstOrThrow).not.toHaveBeenCalled();
  });

  it("listLoans forces a non-librarian to their OWN loans (no cross-borrower leak)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const tx = {
      bookLoan: { findMany },
      libraryBook: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
    } as unknown as TenantTx;
    await svc(tx).listLoans(student, { borrowerId: "someone-else" });
    // The requested borrowerId is ignored; scoped to the caller.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { borrowerId: "stu1" } }));
  });

  // ===========================================================================
  // Catalogue export + report aggregation
  // ===========================================================================
  describe("export and report", () => {
    /** Local harness: these two paths use runAsTenantReadOnly and $queryRaw, which
     *  the shared makeTx above does not model. */
    const mk = (tx: Record<string, unknown>) => {
      const db = {
        runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
        runAsTenantReadOnly: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx as unknown as TenantTx),
      };
      return new LibraryService(db as never, { record: jest.fn() } as never);
    };
    const book = (i: number) => ({
      id: `b${i}`, title: `Title ${i}`, author: "A", isbn: null, barcode: `BC${i}`,
      category: null, totalCopies: 1, availableCopies: 1, customFields: {},
    });

    it("exports the WHOLE catalogue, not the 200 the on-screen list caps at", async () => {
      // Routed through searchBooks (take: 200), a 500-title library exported 200 rows
      // and said nothing — the file looked complete, so the loss would only surface
      // as a stock-take that never reconciled.
      const rows = Array.from({ length: 500 }, (_, i) => book(i));
      const findMany = jest.fn().mockResolvedValue(rows);
      const res = await mk({ libraryBook: { findMany } }).exportCsv(librarian);
      expect(res.truncated).toBe(false);
      expect(res.csv.split("\n")).toHaveLength(501); // header + 500
      // And it asked for more than 200.
      expect((findMany.mock.calls[0][0] as { take: number }).take).toBeGreaterThan(200);
    });

    it("announces truncation IN THE FILE when the ceiling is genuinely hit", async () => {
      // A librarian reconciling stock will not read an HTTP header; they will see
      // the last line of the sheet.
      const rows = Array.from({ length: 20_001 }, (_, i) => book(i));
      const res = await mk({ libraryBook: { findMany: jest.fn().mockResolvedValue(rows) } }).exportCsv(librarian);
      expect(res.truncated).toBe(true);
      expect(res.csv).toContain("truncated at 20000 titles");
    });

    it("reports via SQL aggregates, never by loading every loan row", async () => {
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ issued: 7, returned: 12, overdue: 3, finesAccruedMinor: 45_000, finesCollectedMinor: 20_000 }])
        .mockResolvedValueOnce([{ totalTitles: 120, totalCopies: 300, availableCopies: 281 }]);
      const loanFindMany = jest.fn();
      const bookFindMany = jest.fn();
      const out = await mk({
        $queryRaw: queryRaw,
        bookLoan: { findMany: loanFindMany },
        libraryBook: { findMany: bookFindMany },
      }).report(librarian, {});

      expect(out).toEqual({
        issued: 7, returned: 12, overdue: 3,
        finesAccruedMinor: 45_000, finesCollectedMinor: 20_000,
        totalTitles: 120, totalCopies: 300, availableCopies: 281,
      });
      // The point of the change: no row-loading at all on this path.
      expect(loanFindMany).not.toHaveBeenCalled();
      expect(bookFindMany).not.toHaveBeenCalled();
      expect(queryRaw).toHaveBeenCalledTimes(2);
    });
  });
});
