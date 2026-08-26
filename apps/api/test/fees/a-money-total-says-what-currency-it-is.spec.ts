// =============================================================================
// Every aggregate over per-row money asks which currency it is
// =============================================================================
// Three tables in this platform carry a currency PER ROW, because the money in
// them genuinely differs row to row: `invoice` (a school bills USD through
// Stripe alongside its local currency), `platform_subscription_payment` (naira
// through Paystack, dollars through Stripe) and `agent_commission` (accrued on
// whichever of those the school paid with). `payment` has no currency column of
// its own and INHERITS its invoice's, which is why every aggregate over
// payments has to join rather than assume.
//
// A SUM over any of those without grouping by the currency is not a total: it
// is a count of minor units of two different kinds of money, and the screen
// then puts one symbol in front of it. Four such sums were live at once — the
// invoice summary on /fees and /admin, the analytics fees block, the
// receivables report, and the six-month revenue chart on the operator
// dashboard — while three places in the same codebase had already worked the
// rule out and written it down:
//
//   group.service.ts   "a payment carries no currency of its own — it inherits
//                       its INVOICE's ... precisely the assumption that made
//                       the old totals wrong"
//   operator-payments  "money is NEVER summed across currencies ... the shape
//                       of the answer is what stops the mistake being
//                       reintroduced"
//   platform-analytics "kobo added to cents ... a bug with a start date"
//
// This gate is that shape, enforced. It reads the SQL and the Prisma aggregates
// rather than the results, because the results only differ once a school
// actually holds two currencies — which is exactly when nobody is looking.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "../../src");

/**
 * Aggregates that deliberately do NOT group by currency, each with the reason.
 * A sum restricted to ONE currency is legitimate; a sum that ignores the
 * question is not.
 */
const ALLOWED: Record<string, string> = {
  "operator/platform-analytics.service.ts":
    "The headline MRR and revenue figures are the platform's HOME currency by " +
    "design — every loop that adds them first skips a row in any other currency, " +
    "and the per-currency breakdown lives on the /operator/payments ledger. " +
    "Filtering to one currency is the same answer as grouping by it.",
};

/**
 * Prisma aggregates that ask a question a currency cannot answer, keyed
 * `file: model` with the EXPECTED COUNT.
 *
 * A count, not a bare name: a file-level pass would silence the next ungrouped
 * sum that arrives in the same file for a different reason, which is precisely
 * what the `money-is-not-divided-by-a-hundred` exemption on GrowthManager did —
 * granted for `commissionBp / 100` and quietly covering a `minor / 100` money
 * formatter that landed later.
 */
const ALLOWED_UNGROUPED: Record<string, { count: number; why: string }> = {
  "fees/payment-plans.service.ts: studentCreditEntry": {
    count: 1,
    why:
      "One call, and its result is never a money figure: applyCreditToInvoice " +
      "asks whether the pupil holds ANY credit at all, only to choose between " +
      "'no credit' and 'no credit in THIS currency' in the refusal it is about " +
      "to throw. The BALANCE beside it is grouped by currency, and the spend is " +
      "filtered to one.",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * A raw-SQL statement, read from its opening backtick to the matching one.
 *
 * BOTH FORMS. A statement is written either inline after `$queryRaw` or built
 * as `Prisma.sql` and passed in — and the second is what four of the five
 * offending aggregates used, so a scan matching only the first found three of
 * them and reported no problem. Caught by this file's own magnitude assertion,
 * which is why every walking gate here has one.
 */
function sqlBlocks(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\$queryRaw(?:<[^>]*>)?\s*(?:\(\s*Prisma\.sql)?|Prisma\.sql)\s*`/g)) {
    const from = m.index! + m[0].length;
    // Template literals here contain `${...}` but no nested backticks; read to
    // the next unescaped one rather than guessing a length, for the reason the
    // credit-currency gate does: a statement runs as long as it needs to.
    const end = src.indexOf("`", from);
    if (end > from) out.push(src.slice(from, end));
  }
  return out;
}

/**
 * The OUTERMOST select list — the columns the caller actually receives.
 *
 * // GOTCHA, and my first version had it: reading "everything before the first
 * FROM" reads the first CTE, not the answer. `financeReport` opens with
 * `WITH billable AS (SELECT id, currency, ...)`, so deleting `currency` from
 * the final SELECT and the GROUP BY left the gate GREEN — it was still seeing
 * the word inside the CTE. Caught by mutating the fix this gate exists for,
 * which is the only way that class of false negative ever shows up.
 *
 * So: walk to the LAST `SELECT` at paren depth zero and read to its `FROM`.
 */
function outerSelectList(sql: string): string {
  const word = (at: number, w: string) =>
    sql.slice(at, at + w.length).toLowerCase() === w && !/\w/.test(sql[at - 1] ?? " ") && !/\w/.test(sql[at + w.length] ?? " ");
  let depth = 0;
  let start = -1;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && word(i, "select")) start = i + 6;
  }
  if (start === -1) return sql;
  let end = sql.length;
  depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    else if (depth === 0 && word(i, "from")) {
      end = i;
      break;
    }
  }
  return sql.slice(start, end);
}

/** Money columns whose row-level currency differs across a school's ledger. */
const MONEY_COL = /"?(totalMinor|amountMinor|platformFeeMinor|deltaMinor)"?/;

describe("every SQL sum over per-row money", () => {
  const sums: Array<{ where: string; sql: string }> = [];

  for (const file of walk(API_SRC)) {
    const rel = file.slice(API_SRC.length + 1);
    for (const sql of sqlBlocks(stripComments(readFileSync(file, "utf8")))) {
      if (!/\bSUM\s*\(/i.test(sql)) continue;
      if (!MONEY_COL.test(sql)) continue;
      sums.push({ where: rel, sql });
    }
  }

  it("found the aggregates at all — the scan has not silently broken", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing. The analytics fees block, the receivables report, the invoice
    // summary, the group console's three, and the take-rate.
    expect(sums.length).toBeGreaterThanOrEqual(6);
  });

  it("returns a currency with the money, or is exempted by name with a reason", () => {
    // THE PROPERTY IS THE ANSWER'S SHAPE, not the syntax that produced it.
    // Asking for `GROUP BY ... currency` misses `GROUP BY 1, 2`, which is what
    // three of these actually write — and a caller cannot tell the difference,
    // because what reaches them either has a currency on each row or does not.
    const ungrouped = sums
      .filter((s) => !(s.where in ALLOWED))
      // A `currency` column in the OUTERMOST select list: every row of the
      // result says what money it is.
      // Or an `invoiceId`, where the currency travels with the invoice the
      // caller then joins back to. Both read the OUTER list only.
      //
      // // GOTCHA, the second false negative in this one test: the escape hatch
      // was first written as "the statement contains GROUP BY invoiceId", and
      // every one of these statements has a `net`/`paid` CTE that groups by
      // invoiceId internally — so the hatch matched every statement in the file
      // and the mutation still passed. A CTE's grouping is not the answer's
      // shape either.
      .filter((s) => !/\b(currency|invoiceId)\b/i.test(outerSelectList(s.sql)))
      .map((s) => `${s.where}: ${s.sql.replace(/\s+/g, " ").trim().slice(0, 90)}`);
    expect(ungrouped).toEqual([]);
  });

  it("gives every exemption a real reason, and names a file that exists", () => {
    const files = new Set(walk(API_SRC).map((f) => f.slice(API_SRC.length + 1)));
    for (const [where, why] of Object.entries(ALLOWED)) {
      expect([where, why.length > 60]).toEqual([where, true]);
      // A dangling exemption is a hole waiting for the name to be reused.
      expect([where, files.has(where)]).toEqual([where, true]);
    }
  });
});

describe("every Prisma aggregate over per-row money", () => {
  /** `_sum: { <moneyCol>: true }` on a model whose rows carry a currency. */
  const PER_ROW_CURRENCY_MODELS = ["invoice", "platformSubscriptionPayment", "agentCommission", "studentCreditEntry"];
  const found: Array<{ where: string; model: string; grouped: boolean }> = [];

  for (const file of walk(API_SRC)) {
    const rel = file.slice(API_SRC.length + 1);
    const src = stripComments(readFileSync(file, "utf8"));
    for (const model of PER_ROW_CURRENCY_MODELS) {
      // BOTH FORMS, and the second is the one that bites.
      //
      // Prisma's generated `groupBy` overload cannot express a three-column
      // `by`, so this codebase aliases it — `const groupBy = client.x.groupBy
      // as unknown as (args) => Promise<Array<{ ... currency ... }>>` — and
      // calls the alias. Reading "the call after `x.groupBy(`" then reads the
      // TYPE ANNOTATION, which names `currency` in its return shape whatever
      // the `by` list does. Deleting the currency from the `by` left the gate
      // green, caught only by mutating the fix it exists for.
      //
      // So an alias is resolved to the place it is INVOKED, the same way
      // `every-mutation-leaves-a-trail` resolves an injected property to its
      // class rather than trusting the name in front of it.
      const aliases = [...src.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*[\\w.]*\\b${model}\\.(?:aggregate|groupBy)\\s+as\\b`, "g"))].map((a) => a[1]);
      const invocations = aliases.flatMap((name) => [...src.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].map((a) => a.index! + a[0].length - 1));
      const direct = [...src.matchAll(new RegExp(`\\b${model}\\.(?:aggregate|groupBy)\\s*\\(`, "g"))].map((a) => a.index! + a[0].length - 1);
      for (const at of [...direct, ...invocations]) {
        const m = { index: at + 1 } as { index: number };
        // Read the call to its matching paren — a `by` list and a `where` clause
        // are as long as they need to be, and a fixed window silently stops
        // seeing the `currency` the day one grows.
        const from = m.index - 1;
        let depth = 0;
        let end = from;
        for (let i = from; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const call = src.slice(from, end + 1);
        if (!/_sum\s*:/.test(call)) continue;
        found.push({ where: rel, model, grouped: /\bcurrency\b/.test(call) });
      }
    }
  }

  it("found the aggregates at all", () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it("either groups by currency or restricts to one", () => {
    // `agentCommission` sums a payout; `studentCreditEntry` sums a balance a
    // family spends; `invoice` sums what a leaver owes. All carry a currency per
    // row, so none may be totalled without naming it — by grouping, or by
    // filtering to a single currency.
    const counted = new Map<string, number>();
    for (const f of found.filter((x) => !x.grouped)) {
      const k = `${f.where}: ${f.model}`;
      counted.set(k, (counted.get(k) ?? 0) + 1);
    }
    const offenders: string[] = [];
    for (const [k, n] of counted) {
      const allowed = ALLOWED_UNGROUPED[k];
      // MORE than the exemption accounts for is a NEW one hiding behind an old
      // reason, and is reported as such rather than passing.
      if (!allowed || allowed.count !== n) offenders.push(`${k} (${n}${allowed ? ` — ${allowed.count} exempted` : ""})`);
    }
    expect(offenders).toEqual([]);
  });

  it("gives every ungrouped exemption a reason, and none that is now unused", () => {
    const live = new Set(found.filter((f) => !f.grouped).map((f) => `${f.where}: ${f.model}`));
    for (const [k, v] of Object.entries(ALLOWED_UNGROUPED)) {
      expect([k, v.why.length > 60]).toEqual([k, true]);
      // A dangling exemption is a hole waiting for the name to be reused.
      expect([k, live.has(k)]).toEqual([k, true]);
    }
  });
});

// =============================================================================
// …and the sums that never reach SQL at all
// =============================================================================
// The two halves above cover a `$queryRaw` aggregate and a Prisma `_sum`. The
// third shape is a `reduce` in Node over rows fetched with `findMany`, and it
// is the one the settlement-holding read used:
//
//   amountMinor: rows.reduce((n, r) => n + r.amountMinor, 0)
//
// …over rows whose currency had just been read, one per row, three lines above.
// Measured live on the demo tenant, which already held both: the platform owed
// NGN 22,000.00 and USD 1,300.00, and the operator's card said "Holding
// ₦23,300.00" — kobo added to cents, printed under the platform's own symbol.
// A note directly BELOW it said the money was in more than one currency, so the
// warning was right and the number above it was not.
// =============================================================================
describe("every Node-side sum over per-row money", () => {
  /** A reduce that adds a minor-unit field across rows. */
  const REDUCE = /\.reduce\(\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\1\s*\+\s*\2\.(\w*[Mm]inor)\b/g;

  const found: Array<{ where: string; line: number; scoped: boolean }> = [];
  for (const file of walk(API_SRC)) {
    const rel = file.slice(API_SRC.length + 1);
    const raw = readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const m of src.matchAll(REDUCE)) {
      // The line in the REAL file. Reporting an offset into the stripped copy
      // gives a number that does not open anything — a finding you cannot
      // navigate to is one nobody acts on.
      const at = raw.indexOf(m[0]);
      const line = at >= 0 ? raw.slice(0, at).split("\n").length : 0;
      // Is the thing being reduced narrowed to one currency? Look back over the
      // enclosing statement run for a currency comparison, a per-currency
      // group, or a filter naming one.
      const back = src.slice(Math.max(0, m.index! - 800), m.index!);
      const scoped =
        /currency\b[^\n]{0,40}===|===[^\n]{0,40}\bcurrency\b|currency\s*:\s*[a-zA-Z"'`]|\bby\.get\(|byCurrency|groupBy/.test(back);
      found.push({ where: rel, line, scoped });
    }
  }

  it("found the reduces at all — the scan has not silently broken", () => {
    expect(found.length).toBeGreaterThan(3);
  });

  /**
   * COUNTED, not merely named — the rule this file already learned once.
   *
   * A bare file-level pass is what let `money-is-not-divided-by-a-hundred`'s
   * GrowthManager entry quietly cover a `minor / 100` money formatter that
   * landed in the same file later. A count means a NEW unscoped reduce in an
   * already-exempted file still fails.
   *
   * What makes each of these safe is the same property: the rows being added
   * all hang off ONE parent that carries the currency — one invoice, one
   * payslip — so there is no second currency for them to be in.
   */
  const ALLOWED_REDUCE: Record<string, { count: number; reason: string }> = {
    "fees/fees.service.ts": {
      count: 1,
      reason: "payments of ONE invoice; a payment inherits its invoice's currency, so there is only one",
    },
    "fees/payment-plans.service.ts": {
      count: 1,
      reason: "instalment tranches of ONE invoice, checked against that invoice's own total",
    },
    "hr/payroll.service.ts": {
      count: 1,
      reason: "NHF deduction components within ONE payslip, which is denominated once",
    },
  };

  it("adds money only within one currency", () => {
    const unscoped = found.filter((f) => !f.scoped);
    const byFile = new Map<string, number>();
    for (const f of unscoped) byFile.set(f.where, (byFile.get(f.where) ?? 0) + 1);
    const offenders = unscoped
      .filter((f) => (byFile.get(f.where) ?? 0) > (ALLOWED_REDUCE[f.where]?.count ?? 0))
      .map((f) => `${f.where}:${f.line}`);
    expect(offenders).toEqual([]);
  });

  it("gives every exemption a reason, and none that is now unused", () => {
    const unscoped = found.filter((f) => !f.scoped);
    for (const [file, { count, reason }] of Object.entries(ALLOWED_REDUCE)) {
      expect(reason.length).toBeGreaterThan(30);
      // An exemption for something that no longer happens is a hole waiting
      // for the file to grow a real one back.
      expect(unscoped.filter((f) => f.where === file)).toHaveLength(count);
    }
  });
});
