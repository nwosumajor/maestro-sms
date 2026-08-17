// =============================================================================
// Three more guards that were only reads — and what each one actually cost
// =============================================================================
// Continuing the sweep from #250/#251. The rule for triage is CONSEQUENCE of a
// double execution, not the count: 59 methods have the shape, and for a forum
// post or a chess move it costs nothing. These four were opened because they
// move money, a ballot, or a person's final pay. Two were real, one was already
// safe, and one turned out to be a rough edge rather than a defect.
//
// 1. LIBRARY payFine — REAL, money.
//    Reads `loan.finePaid`, then writes the flag AND creates a Payment. Setting
//    the flag twice is idempotent and looks harmless; posting the Payment twice
//    is not. `payment` has NO unique index that a duplicate fine would violate
//    (checked in pg_indexes), so the invoice is credited twice for money handed
//    over once, and can tip into PAID or throw off an overpayment credit.
//
// 2. HR exit decide — REAL, money.
//    Reads `status === "PENDING"`, then posts `loan_repayment` rows against the
//    departing member's outstanding loans and decrements each balance. The
//    unique index `(loanId, payrollRunId)` does NOT save it: the exit path
//    writes `payrollRunId: null`, and Postgres treats NULLs as DISTINCT, so a
//    second identical row is perfectly legal. The balance is written as
//    `balance - take` from an earlier read, so it is a lost update too.
//
// 3. POLL vote — NOT a defect. Checked rather than assumed: the schema declares
//    `@@unique([pollId, voterId])` AND the index really exists in the database
//    (`poll_vote_pollId_voterId_key`), so the ballot cannot be stuffed — the
//    second insert is refused by Postgres. What it WAS is a 500, because the
//    P2002 was unhandled; that is what a double-click looked like to a voter.
//
// 4. HR decideLoan and HOSTEL vacate — NOT defects, and worth recording so
//    nobody re-opens them. Both only set a status, both writes are identical,
//    and neither maintains a counter: room occupancy is a COUNT of ACTIVE rows
//    (which is why allocate takes `FOR UPDATE` around the count), not a stored
//    number that could drift.
// =============================================================================

import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

/** Comments stripped: an assertion that matches the explanation of a fix
 *  instead of the fix passes when the fix is deleted. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

function bodyOf(src: string, name: string): string {
  const decl = new RegExp(`^\\s*(private |public |protected )?(async )?${name}\\s*\\(`, "m");
  const m = decl.exec(src);
  if (!m) throw new Error(`no declaration of ${name}`);
  const open = src.indexOf("{", src.indexOf(")", m.index + m[0].length - 1));
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) return src.slice(open, i);
  }
  throw new Error(`unterminated ${name}`);
}

describe("paying a library fine", () => {
  const body = bodyOf(SRC("library/library.service.ts"), "payFine");

  it("claims the settlement rather than trusting the finePaid read", () => {
    expect(code(body)).toMatch(/updateMany\(\{[\s\S]*?finePaid: false/);
  });

  it("posts the money only after winning the claim", () => {
    // Otherwise the loser of the race still creates a Payment, and nothing on
    // the payment table would stop it.
    expect(body.indexOf("claimed.count === 0")).toBeLessThan(body.indexOf("payment.create"));
  });

  it("keeps the two distinct refusals", () => {
    // "No fine to pay" and "Fine already paid" are different answers and a
    // single claim cannot tell them apart — so the reads stay, for the message.
    expect(body).toMatch(/No fine to pay/);
    expect(body).toMatch(/Fine already paid/);
  });
});

describe("approving a staff exit", () => {
  const body = bodyOf(SRC("hr/exit.service.ts"), "decide");

  it("claims the decision before settling anything", () => {
    expect(code(body)).toMatch(/updateMany\(\{[\s\S]*?status: "PENDING"/);
  });

  it("recovers loans only after winning the claim", () => {
    expect(body.indexOf("claimed.count === 0")).toBeLessThan(body.indexOf("loanRepayment.create"));
  });

  it("still refuses the person who raised the exit", () => {
    // Separation of duties must stay BEFORE any write.
    const sod = body.indexOf("separation of duties");
    expect(sod).toBeGreaterThan(-1);
    expect(sod).toBeLessThan(body.indexOf("updateMany"));
  });

  it("records WHY the unique index does not cover this", () => {
    // `(loanId, payrollRunId)` with a null payrollRunId is not a constraint.
    expect(body).toMatch(/NULLs as DISTINCT|NULLs are distinct/i); // prose, deliberately
  });
});

describe("voting in a poll", () => {
  const body = bodyOf(SRC("poll/poll.service.ts"), "vote");

  it("answers a double-click with a 400, not an unhandled P2002", () => {
    const c = code(body);
    expect(c).toMatch(/e\.code === "P2002"/);
    expect(c).toMatch(/BadRequestException\("You have already voted in this poll"\)[\s\S]{0,40}\}/);
  });

  it("still leans on the database for the actual rule", () => {
    // The application check cannot enforce one-vote-per-member; the unique
    // index does. This test exists so nobody "simplifies" the try/catch away
    // on the grounds that the read above already checks it.
    expect(body).toMatch(/pollVote\.create/);
    expect(SRC("../../../packages/db/prisma/schema/poll.prisma")).toMatch(
      /@@unique\(\[pollId, voterId\]\)/,
    );
  });
});

describe("the ones deliberately left alone", () => {
  it("hostel vacate has no counter to corrupt", () => {
    // Occupancy is counted from ACTIVE allocations, so a double vacate writes
    // the same status twice and changes nothing. The ALLOCATE path locks the
    // room because that one does read-count-then-write.
    const src = SRC("hostel/hostel.service.ts");
    expect(src).toMatch(/FOR UPDATE/);
    expect(bodyOf(src, "vacate")).not.toMatch(/decrement|increment/);
  });

  it("HR decideLoan only sets a status", () => {
    const body = bodyOf(SRC("hr/compensation.service.ts"), "decideLoan");
    expect(body).not.toMatch(/\.create\(/);
  });
});

/** A sanity check on the exception type the claims throw, so the message a
 *  caller sees is a 400 rather than a 500. */
describe("what a lost claim returns", () => {
  it("is a BadRequest in every case", () => {
    for (const [file, fn] of [
      ["library/library.service.ts", "payFine"],
      ["library/library.service.ts", "returnLoan"],
      ["hr/exit.service.ts", "decide"],
      ["fees/fee-ops.service.ts", "decideAdjustment"],
    ] as const) {
      const body = bodyOf(SRC(file), fn);
      const at = body.indexOf("claimed.count === 0");
      expect([file, fn, at]).not.toEqual([file, fn, -1]);
      expect([file, fn, body.slice(at, at + 120)]).toEqual([
        file,
        fn,
        expect.stringContaining("BadRequestException"),
      ]);
    }
    expect(BadRequestException).toBeDefined();
  });
});
