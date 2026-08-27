// =============================================================================
// A renewal erased the fine that had already accrued
// =============================================================================
// The overdue fine is computed ONLY at return, from the loan's CURRENT `dueAt`,
// and `renew` sets `dueAt = max(dueAt, now) + RENEW_DAYS`. So renewing an overdue
// loan pushed the due date into the future and the days already late stopped
// existing.
//
// `library.borrow` is held by STUDENT, and `renew` accepts the borrower
// themselves — so this needed no staff at all. Measured live on one 30-day
// overdue loan of the same book:
//
//   returned without renewing        -> fine NGN 1,500.00
//   pupil renews their own, returns  -> fine NGN 0.00
// =============================================================================

import { LibraryService } from "../../src/library/library.service";

const DAY = 86_400_000;

/** The pupil themselves: holds `library.borrow`, NOT `library.manage`. That is
 *  the whole point — no staff were needed to erase the fine. */
const BORROWER = { userId: "stu1", schoolId: "s", permissions: ["library.borrow"] } as never;

/** The service's own late-day rule, read by the renewal AND the return. */
const lateDaysAt = (dueAt: Date, at: Date) =>
  (LibraryService.prototype as unknown as {
    lateDaysAt: (d: Date, a: Date) => number;
  }).lateDaysAt(dueAt, at);

describe("a renewal does not erase a fine", () => {
  it("counts whole days past the due date, never negative", () => {
    const now = new Date();
    expect(lateDaysAt(new Date(now.getTime() - 30 * DAY), now)).toBe(30);
    expect(lateDaysAt(new Date(now.getTime() + 5 * DAY), now)).toBe(0);
  });

  it("banks the days already late when the due date is moved", async () => {
    const { svc, updates } = renewable({ overdueDays: 30 });
    await svc.renew(BORROWER, "l1");
    // The claim that actually moves the row must carry the banked days with it,
    // in the SAME write that moves `dueAt` — anything else leaves a window in
    // which the days have been forgotten.
    expect(updates[0].data).toMatchObject({
      renewedCount: { increment: 1 },
      lateDaysCarried: { increment: 30 },
    });
    expect(updates[0].data.dueAt).toBeInstanceOf(Date);
  });

  it("banks nothing when the loan was not late", async () => {
    const { svc, updates } = renewable({ overdueDays: 0 });
    await svc.renew(BORROWER, "l1");
    expect(updates[0].data.lateDaysCarried).toBeUndefined();
  });

  it("CHARGES the banked days at return, not just banks them", async () => {
    // The other half, and mutation testing is what found it missing: deleting
    // the carried term from the fine calculation left every assertion above
    // green, because they all watch the RENEWAL and none watched the return.
    const { svc, billed } = returnable({ carried: 30, sinceDue: 0 });
    await svc.returnLoan(LIBRARIAN, "l1");
    // 30 banked days at the school's rate, even though the current due date has
    // not yet passed.
    expect(billed.fineMinor).toBe(30 * 5_000);
  });

  it("adds the banked days to any accrued since the new due date", async () => {
    const { svc, billed } = returnable({ carried: 30, sinceDue: 4 });
    expect((await svc.returnLoan(LIBRARIAN, "l1"), billed.fineMinor)).toBe(34 * 5_000);
  });

  it("charges nothing when a loan was never late at all", async () => {
    const { svc, billed } = returnable({ carried: 0, sinceDue: 0 });
    await svc.returnLoan(LIBRARIAN, "l1");
    expect(billed.fineMinor).toBe(0);
  });

  it("records the carried days on the audit row", async () => {
    // A fine that survives a renewal must be explainable from the trail, or it
    // looks like a mistake at the desk.
    const { svc, audit } = renewable({ overdueDays: 12 });
    await svc.renew(BORROWER, "l1");
    expect(JSON.stringify(audit)).toContain("lateDaysCarried");
    expect(audit[0].metadata).toMatchObject({ lateDaysCarried: 12 });
  });
});

/** A librarian: holds `library.manage`, which is what a return requires. */
const LIBRARIAN = {
  userId: "lib1",
  schoolId: "s",
  permissions: ["library.manage", "library.borrow"],
} as never;

/** The real service over a return, watching what the fine comes out as. */
function returnable(opts: { carried: number; sinceDue: number }) {
  const billed: { fineMinor: number } = { fineMinor: -1 };
  const loan = {
    id: "l1",
    bookId: "b1",
    borrowerId: "stu1",
    status: "ISSUED",
    dueAt: new Date(Date.now() - opts.sinceDue * DAY),
    renewedCount: 1,
    lateDaysCarried: opts.carried,
    fineMinor: 0,
    finePaid: false,
    issuedAt: new Date(),
    returnedAt: null,
  };
  const tx = {
    bookLoan: {
      findFirst: async () => loan,
      findFirstOrThrow: async () => ({ ...loan, status: "RETURNED", returnedAt: new Date() }),
      updateMany: async (a: { data: { fineMinor?: number } }) => {
        if (typeof a.data.fineMinor === "number") billed.fineMinor = a.data.fineMinor;
        return { count: 1 };
      },
      update: async (a: { data: { fineMinor?: number } }) => {
        if (typeof a.data.fineMinor === "number") billed.fineMinor = a.data.fineMinor;
        return loan;
      },
    },
    libraryBook: {
      findFirstOrThrow: async () => ({ title: "Probe Reader", barcode: "P1" }),
      update: async () => ({}),
    },
    school: { findFirst: async () => ({ libraryFinePerDayMinor: 5_000, currency: "NGN" }) },
    user: { findFirst: async () => ({ id: "stu1", name: "Demo Student" }) },
    invoice: { findFirst: async () => null, create: async () => ({ id: "inv1" }), update: async () => ({}) },
    invoiceLineItem: { findFirst: async () => null, create: async () => ({}) },
  };
  const svc = Object.create(LibraryService.prototype) as LibraryService;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: { record: async () => undefined },
    notifications: { enqueue: async () => undefined },
  });
  return { svc, billed, tx };
}

function renewable(opts: { overdueDays: number }) {
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const audit: Array<{ metadata: Record<string, unknown> }> = [];
  const loan = {
    id: "l1",
    bookId: "b1",
    borrowerId: "stu1",
    status: "ISSUED",
    dueAt: new Date(Date.now() - opts.overdueDays * DAY),
    renewedCount: 0,
    lateDaysCarried: 0,
    fineMinor: 0,
    finePaid: false,
    issuedAt: new Date(),
    returnedAt: null,
  };
  const tx = {
    bookLoan: {
      findFirst: async () => loan,
      findFirstOrThrow: async () => loan,
      updateMany: async (a: { data: Record<string, unknown> }) => {
        updates.push(a);
        return { count: 1 };
      },
    },
    libraryBook: { findFirstOrThrow: async () => ({ title: "Probe Reader", barcode: "P1" }) },
    user: { findFirst: async () => ({ id: "stu1", name: "Demo Student" }) },
  };
  const svc = Object.create(LibraryService.prototype) as LibraryService;
  Object.assign(svc, {
    db: { runAsTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) },
    audit: {
      record: async (entry: { metadata: Record<string, unknown> }) => {
        audit.push(entry);
      },
    },
  });
  return { svc, updates, audit, tx };
}
