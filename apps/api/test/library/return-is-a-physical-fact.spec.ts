// =============================================================================
// The pupil who returned the book without returning the book
// =============================================================================
// `returnLoan` accepted the BORROWER as well as library staff, and the web
// rendered a "Return" button on every loan row — ungated, unlike the "Pay fine"
// button directly beneath it. Live:
//
//   librarian adds a book   -> 201 | copies available: 1
//   pupil self-issues       -> 201 | loan d9597ac3
//   PUPIL marks it RETURNED -> 201 | status: RETURNED | fine: 0
//   shelf now says available-> 1     — the book itself was never handed to anyone
//
// A return record asserts a physical fact, and every consequence follows from
// that one assertion:
//
//   * the copy goes back into `availableCopies`, so the library believes it holds
//     a book it does not hold and issues a phantom to the next borrower;
//   * the overdue fine is computed AT THE MOMENT OF RETURN, so self-returning
//     freezes it — a pupil can stop the meter and keep the book;
//   * the loan leaves the overdue list, so no report ever names them again.
//
// None of that needs bad intent: a pupil who has simply LOST a book can close
// their own liability with one button.
//
// The platform already draws this line elsewhere for the same reason — who may
// TAKE an attendance register is restricted because the register records who
// physically looked at the room. RENEWAL stays self-service: extending a due
// date asserts nothing about where the book is.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import { LibraryService } from "../../src/library/library.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const pupil: Principal = {
  schoolId: "school-A",
  userId: "pupil-1",
  roles: ["student"],
  permissions: ["library.read", "library.borrow"],
};
const librarian: Principal = {
  schoolId: "school-A",
  userId: "lib-1",
  roles: ["librarian"],
  permissions: ["library.read", "library.borrow", "library.manage"],
};

function makeService() {
  const loan = {
    id: "loan-1",
    borrowerId: "pupil-1",
    bookId: "book-1",
    status: "ISSUED",
    dueAt: new Date(Date.now() - 3 * 86_400_000), // three days overdue
    renewedCount: 0,
    fineMinor: 0,
  };
  const tx = {
    bookLoan: {
      findFirst: jest.fn(async () => loan),
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    libraryBook: {
      findFirst: jest.fn(async () => ({ id: "book-1", title: "Physics", availableCopies: 0, totalCopies: 1 })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    invoiceLineItem: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    invoice: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: "inv-1" })), update: jest.fn(async () => ({})) },
    school: { findFirst: jest.fn(async () => ({ currency: "NGN" })) },
    user: { findFirst: jest.fn(async () => ({ id: "pupil-1", name: "Pupil" })), findMany: jest.fn(async () => []) },
    auditLog: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const service = new LibraryService(db as never, { record: jest.fn() } as never);
  jest.spyOn(service as never, "loanDto").mockResolvedValue({ id: "loan-1", status: "RETURNED" } as never);
  return { service, tx };
}

describe("recording a return", () => {
  it("REFUSES the borrower — this is the defect", async () => {
    const { service } = makeService();
    await expect(service.returnLoan(pupil, "loan-1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("tells them what to do instead", async () => {
    // NOTE, verified live: a pupil calling the endpoint gets the ROUTE GUARD's
    // generic "Forbidden" — `library.manage` refuses before the service runs, so
    // this message is the second layer, not what a pupil reads. It matters if
    // the gate is ever widened, and it is what any in-process caller sees. The
    // pupil's real fix is the button no longer being there.
    const { service } = makeService();
    await expect(service.returnLoan(pupil, "loan-1")).rejects.toThrow(/hand.*in|library desk/i);
  });

  it("touches NOTHING when it refuses", async () => {
    // The copy must not go back on the shelf, and the fine must not be frozen,
    // on a call that was rejected.
    const { service, tx } = makeService();
    await service.returnLoan(pupil, "loan-1").catch(() => undefined);
    expect(tx.bookLoan.update).not.toHaveBeenCalled();
    expect(tx.libraryBook.update).not.toHaveBeenCalled();
    expect(tx.libraryBook.updateMany).not.toHaveBeenCalled();
  });

  it("lets library staff record it", async () => {
    const { service } = makeService();
    await expect(service.returnLoan(librarian, "loan-1")).resolves.toBeDefined();
  });

  it("still charges the overdue fine when staff record it", async () => {
    // The fine is the point of the return path; restricting who may call it must
    // not quietly disable it.
    const { service, tx } = makeService();
    await service.returnLoan(librarian, "loan-1");
    expect(tx.invoiceLineItem.create).toHaveBeenCalled();
  });
});

describe("what a borrower can still do", () => {
  it("renew their own loan — no physical claim is being made", async () => {
    const { service } = makeService();
    await expect(service.renew(pupil, "loan-1")).resolves.toBeDefined();
  });
});

describe("the route gate agrees with the service", () => {
  // The discipline fix taught this: widening or narrowing the service alone is
  // invisible to the guard, and a suite that builds the service directly cannot
  // see a decorator.
  const CONTROLLER = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/library/library.controller.ts"),
    "utf8",
  ) as string;

  it("the return route requires library.manage", () => {
    const at = CONTROLLER.indexOf('@Post("loans/:id/return")');
    expect(CONTROLLER.slice(at, at + 160)).toContain("LIBRARY_MANAGE");
  });

  it("the renew route is still open to borrowers", () => {
    const at = CONTROLLER.indexOf('@Post("loans/:id/renew")');
    expect(CONTROLLER.slice(at, at + 160)).toContain("LIBRARY_BORROW");
  });
});

describe("the web does not offer what the API refuses", () => {
  it("the Return button is gated on canManage", () => {
    // It rendered on every loan row, so a pupil was shown a button that will now
    // 403 — an affordance that fails is worse than one that is not there.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../../../web/components/library/LibraryManager.tsx"),
      "utf8",
    ) as string;
    const at = src.indexOf("library/loans/${l.id}/return");
    expect(src.slice(Math.max(0, at - 400), at)).toMatch(/canManage &&/);
  });
});
