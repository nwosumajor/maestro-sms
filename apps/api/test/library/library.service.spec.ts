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
    libraryBook: {
      findFirst: jest.fn().mockResolvedValue(over.book ?? { id: "b1", availableCopies: 2, totalCopies: 3, barcode: "BC1", title: "Book" }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: "b1", title: "Book", barcode: "BC1" }),
      findMany: jest.fn().mockResolvedValue([{ totalCopies: 3, availableCopies: 2 }]),
      create: jest.fn().mockResolvedValue({ id: "b1" }),
      update: jest.fn((a: { data: { availableCopies?: { decrement?: number; increment?: number } } }) => {
        if (a.data.availableCopies?.decrement) calls.bookDec++;
        if (a.data.availableCopies?.increment) calls.bookInc++;
        return Promise.resolve({});
      }),
    },
    bookLoan: {
      findFirst: jest.fn().mockResolvedValue(over.loan ?? null),
      findFirstOrThrow: jest.fn().mockResolvedValue(over.loanRow ?? { id: "l1", bookId: "b1", borrowerId: "stu1", status: "ISSUED", issuedAt: new Date(), dueAt: new Date(Date.now() + 14 * DAY), returnedAt: null, renewedCount: 0, fineMinor: 0, finePaid: false }),
      create: jest.fn(() => { calls.loanCreate++; return Promise.resolve({ id: "l1" }); }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: "stu1", name: "Stu" }) },
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

  it("a student cannot return another borrower's loan (404)", async () => {
    const { tx } = makeTx({ loan: { id: "l1", bookId: "b1", borrowerId: "someone-else", status: "ISSUED", dueAt: new Date() } });
    await expect(svc(tx).returnLoan(student, "l1")).rejects.toThrow(/not found/i);
  });
});
