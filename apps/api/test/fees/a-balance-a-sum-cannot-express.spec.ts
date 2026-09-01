// =============================================================================
// A Prisma `_sum` cannot subtract a refund
// =============================================================================
// Net paid is POSTED payments MINUS POSTED refunds — `FeesService.paidMinor` has
// always said so, and fifteen sites hand-write that reduce correctly. But
// `_sum: { amountMinor: true }` cannot express a sign, so every aggregate over
// `payment` approximated it, two ways, and BOTH understate what a family owes:
//
//   where: { status: POSTED, kind: PAYMENT }   refunds excluded -> short by the refund
//   where: { status: POSTED }                  refunds positive -> short by twice it
//
// This gate exists because FOUR sites had it and I fixed three, missing the
// leavers list — whose own comment already said "the same defect as the exit
// preview above" about an earlier divergence between exactly those two. A rule
// that has to be remembered is one that will be missed; `fees/net-paid.ts` is
// where it lives, and an aggregate that wants to answer this question must be
// named here with a reason it does not need the sign.
// =============================================================================

import { readFileSync } from "fs";
import { stripComments } from "../support/strip-comments";
import { join } from "path";
import { walkSources } from "../support/api-routes";

const SRC = join(__dirname, "../../src");

/**
 * Aggregates over `payment` that sum money and are NOT computing what an invoice
 * has been paid. Each says why the refund sign does not apply.
 */
const NOT_A_BALANCE: Record<string, string> = {
  "src/fees/payment-gateway.service.ts":
    "heldByPlatformMinor — money sitting in the PLATFORM's account awaiting a " +
    "settlement release. A refund to the payer is not a release to the school, " +
    "so kind: PAYMENT is genuinely the question being asked.",
  "src/fees/fees.service.ts":
    "the maker-checker WINDOW total — how much has been recorded in the last N " +
    "hours, so splitting a payment cannot slip under the threshold. A refund does " +
    "not create headroom, and letting it subtract would reopen that hole.",
};

// NOTE the scope: only aggregates over `payment` itself. The operator revenue
// ledger and agent commissions aggregate platform_subscription_payment,
// message_credit_entry and agent_commission — different tables, none of which
// has a REFUND kind, so the sign does not arise. Naming them here would have
// been an exemption for a rule they were never subject to, and this gate said
// so by finding two sites where the list claimed four.

const AGGREGATE = /\b(?:tx|db|client)\.payment\.(?:aggregate|groupBy)\s*\(/g;

/**
 * A `payment.findMany` selecting `amountMinor` WITHOUT `kind`.
 *
 * The aggregate rule above missed a whole shape: a hand-rolled reduce. The fee
 * REMINDER summed every POSTED row as a positive, so a refund made a family look
 * like they owed less — measured live, an invoice with NGN 50,300 outstanding
 * reminded them of **NGN 49,500**, short by twice the refund, in the message
 * that asks them to pay.
 *
 * Selecting `kind` is the tell: a caller that has it can express the sign, and
 * `netPaidOf` is what does. A caller that does not select it CANNOT, however its
 * loop is written.
 */
const FIND_MANY = /\b(?:tx|db|client)\.payment\.findMany\s*\(/g;

describe("a balance a _sum cannot express", () => {
  const files = walkSources(SRC);

  it("scanned a believable number of sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no payment.findMany sums amountMinor without knowing the kind", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"))
        
        .replace(/^[ \t]*\/\/.*$/gm, "");
      // net-paid.ts is where the sign IS expressed.
      if (file.endsWith("net-paid.ts")) continue;
      for (const m of src.matchAll(FIND_MANY)) {
        seen += 1;
        // The call's own argument object, to its matching brace.
        let i = m.index + m[0].length, depth = 0, end = i;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth += 1;
          else if (src[end] === ")") { if (depth === 0) break; depth -= 1; }
        }
        const call = src.slice(i, end);
        if (!/amountMinor/.test(call)) continue;
        if (/\bkind\b/.test(call)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file.replace(SRC + "/", "")}:${line}`);
      }
    }
    expect(seen).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it("no aggregate over payment answers 'what has this been paid'", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const rel = file.replace(SRC, "src");
      const src = stripComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(AGGREGATE)) {
        // Only the ones that sum MONEY are in scope; a _count is fine.
        const after = src.slice(m.index ?? 0, (m.index ?? 0) + 400);
        if (!after.includes("amountMinor")) continue;
        seen += 1;
        if (!NOT_A_BALANCE[rel]) offenders.push(`${rel}: use netPaidMinor/netPaidByInvoice`);
      }
    }
    // The exemptions are the point of the gate; if they all vanish it is
    // watching nothing.
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it("names only files that still exist", () => {
    // A dangling exemption is a hole waiting for the name to be reused.
    for (const rel of Object.keys(NOT_A_BALANCE)) {
      const src = stripComments(readFileSync(join(SRC, rel.replace(/^src\//, "")), "utf8"));
      expect(src).toContain("payment.");
    }
  });

  it("gives every exemption a reason, not just a name", () => {
    for (const [rel, why] of Object.entries(NOT_A_BALANCE)) {
      expect(why.length).toBeGreaterThan(40);
      expect(rel.startsWith("src/")).toBe(true);
    }
  });
});
