// =============================================================================
// Returning a book twice put stock on the shelf that does not exist
// =============================================================================
// Issuing a copy was made atomic on purpose — the service says so:
//
//     // `availableCopies >= 1` read and drive the count negative. Claim first,
//     updateMany({ where: { id, availableCopies: { gte: 1 } }, decrement })
//
// Returning one was not. It read `status !== "ISSUED"`, then wrote. Both are
// reads at READ COMMITTED (no isolationLevel is set anywhere — Postgres's
// default), so two returns of the SAME loan both see ISSUED before either
// commits, both pass the guard, and both do everything after it: bill the fine
// AND put a copy back.
//
// Proven by interleaving the service's own statements in two psql sessions:
//
//     stock before                     3 total, 2 available
//     two interleaved returns of ONE loan
//     stock after                      3 total, 4 available   <- phantom
//
// Four copies of a book the school owns three of, and it never corrects itself,
// because nothing ever recounts.
//
// HONESTLY: six concurrent HTTP returns did NOT reproduce it — 1 succeeded and
// 5 were refused. The window is narrow. That is a reason to close it cheaply,
// not a reason to call it safe: a double-clicked button, a retried request or a
// slower database widens it, and the issue path was worth hardening against the
// identical shape.
//
// `renew` had it too: read `renewedCount`, compare to MAX_RENEWALS, increment.
// Two concurrent renewals both pass the cap check and the cap is exceeded.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LibraryService } from "../../src/library/library.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const librarian: Principal = {
  schoolId: "S",
  userId: "u-lib",
  roles: ["librarian"],
  permissions: ["library.manage", "library.read"],
};

const DAY = 86_400_000;

/**
 * A tx whose `updateMany` behaves like the database: it only matches while the
 * row still satisfies the `where`, so the SECOND caller gets count 0 — which is
 * the whole point of the claim.
 */
function makeService(loan: { id: string; status: string; renewedCount: number; dueAt: Date }) {
  const state = { ...loan };
  const stock = { available: 2 };
  const fines: number[] = [];
  const tx = {
    bookLoan: {
      findFirst: jest.fn(async () => ({ ...state, bookId: "b-1", borrowerId: "s-1", fineMinor: 0 })),
      updateMany: jest.fn(
        async (a: {
          where: { status?: string; renewedCount?: { lt: number } };
          data: Record<string, unknown>;
        }) => {
          if (a.where.status && state.status !== a.where.status) return { count: 0 };
          if (a.where.renewedCount && state.renewedCount >= a.where.renewedCount.lt) return { count: 0 };
          if (typeof a.data.status === "string") state.status = a.data.status;
          if (a.data.renewedCount) state.renewedCount += 1;
          return { count: 1 };
        },
      ),
      update: jest.fn(async () => ({ ...state })),
    },
    libraryBook: {
      update: jest.fn(async () => {
        stock.available += 1;
        return {};
      }),
      findFirst: jest.fn(async () => ({ id: "b-1", title: "A Book", availableCopies: stock.available })),
    },
    user: { findFirst: jest.fn(async () => ({ id: "s-1", name: "A Pupil" })) },
    invoice: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: "inv-1" })) },
    invoiceLineItem: { create: jest.fn(async () => ({})) },
  } as unknown as TenantTx;
  const db = { runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const svc = new LibraryService(db as never, { record: jest.fn() } as never, { enqueue: jest.fn() } as never);
  jest
    .spyOn(svc as unknown as { loanDto: () => unknown }, "loanDto")
    .mockResolvedValue({ id: state.id } as never);
  jest
    .spyOn(svc as unknown as { billFine: () => unknown }, "billFine")
    .mockImplementation((async (_tx: unknown, _p: unknown, _l: unknown, minor: number) => {
      fines.push(minor);
    }) as never);
  return { svc, stock, fines, state };
}

const ISSUED = () => ({
  id: "l-1",
  status: "ISSUED",
  renewedCount: 0,
  dueAt: new Date(Date.now() + 3 * DAY),
});

describe("returning the same loan twice", () => {
  it("puts the copy back exactly once", async () => {
    const { svc, stock } = makeService(ISSUED());
    await svc.returnLoan(librarian, "l-1");
    await expect(svc.returnLoan(librarian, "l-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.available).toBe(3); // 2 + one copy, not two
  });

  it("bills the overdue fine exactly once", async () => {
    // The second caller used to get all the way past the status read, so the
    // borrower was charged twice for one late book.
    const overdue = { ...ISSUED(), dueAt: new Date(Date.now() - 5 * DAY) };
    const { svc, fines } = makeService(overdue);
    await svc.returnLoan(librarian, "l-1");
    await expect(svc.returnLoan(librarian, "l-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(fines).toHaveLength(1);
  });

  it("does nothing at all when the claim is lost", async () => {
    // Not merely "does not double" — the loser must not bill, must not restock.
    const { svc, stock, fines } = makeService({ ...ISSUED(), status: "RETURNED" });
    await expect(svc.returnLoan(librarian, "l-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(stock.available).toBe(2);
    expect(fines).toEqual([]);
  });

  it("still works normally the first time", async () => {
    const { svc, stock, state } = makeService(ISSUED());
    await svc.returnLoan(librarian, "l-1");
    expect(state.status).toBe("RETURNED");
    expect(stock.available).toBe(3);
  });
});

describe("renewing past the cap", () => {
  it("cannot be pushed over MAX_RENEWALS by a second concurrent call", async () => {
    const MAX = Number(/MAX_RENEWALS = (\d+)/.exec(
      readFileSync(join(__dirname, "../../src/library/library.service.ts"), "utf8"),
    )?.[1]);
    expect(MAX).toBeGreaterThan(0);
    const { svc, state } = makeService({ ...ISSUED(), renewedCount: MAX - 1 });
    await svc.renew(librarian, "l-1");
    expect(state.renewedCount).toBe(MAX);
    await expect(svc.renew(librarian, "l-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(state.renewedCount).toBe(MAX);
  });

  it("cannot renew a loan that was returned first", async () => {
    const { svc, state } = makeService(ISSUED());
    await svc.returnLoan(librarian, "l-1");
    await expect(svc.renew(librarian, "l-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(state.renewedCount).toBe(0);
  });
});

describe("the shape, so it is not undone", () => {
  const SRC = readFileSync(join(__dirname, "../../src/library/library.service.ts"), "utf8");
  const bodyOf = (name: string) => {
    const at = SRC.search(new RegExp(`async ${name}\\s*\\(`));
    const open = SRC.indexOf("{", SRC.indexOf(")", at));
    let d = 0;
    for (let i = open; i < SRC.length; i++) {
      if (SRC[i] === "{") d++;
      else if (SRC[i] === "}" && --d === 0) return SRC.slice(open, i);
    }
    return "";
  };

  it("claims the return with a conditional update", () => {
    expect(bodyOf("returnLoan")).toMatch(/updateMany\(\{[\s\S]*?status: "ISSUED"/);
  });

  it("does everything with a consequence AFTER the claim", () => {
    // Billing before the claim would charge the loser of the race.
    const body = bodyOf("returnLoan");
    expect(body.indexOf("claimed.count === 0")).toBeLessThan(body.indexOf("billFine"));
    expect(body.indexOf("claimed.count === 0")).toBeLessThan(body.indexOf("availableCopies"));
  });

  it("claims the renewal against the cap in the same statement", () => {
    expect(bodyOf("renew")).toMatch(/renewedCount: \{ lt: MAX_RENEWALS \}/);
  });
});
