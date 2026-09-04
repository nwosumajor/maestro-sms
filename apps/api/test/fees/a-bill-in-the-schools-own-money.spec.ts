// =============================================================================
// Every invoice this platform raises is denominated in the SCHOOL's currency
// =============================================================================
// Four services create an `invoice`: library fines, hostel rent, transport
// fares, and `FeesService.createInvoice` — the one a bursar uses to bill
// tuition, which is to say the one that raises nearly all of the money.
//
// Three of them resolved `school.currency` and one hard-coded `"NGN"`. Measured
// live on a US school with `currency = 'USD'` explicitly set: the invoice came
// back NGN. Sibling asymmetry, with the careful halves written first and the
// central one left.
//
// It is not a cosmetic label:
//   * `initInvoicePayment` branches on `invoice.currency` to choose the rail;
//   * `applyOnlinePayment` REFUSES a charge whose currency differs from the
//     invoice, before the idempotency check;
//   * the student CREDIT ledger is denominated in the SCHOOL's currency, so an
//     overpayment credit could never be spent against these invoices — observed
//     live as an invoice in NGN beside a credit ledger reading USD, `balances:
//     []`.
//
// This gate reads the SOURCE rather than a fixture, because the defect is a
// literal in a `data:` block and a fixture proves nothing about the other three.
// It asserts the PROPERTY — every writer resolves the school's currency — so it
// keeps holding if the resolution changes shape, and it names the writers so an
// empty offender list cannot pass for code that stopped creating invoices.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = join(__dirname, "../../src");

/** Every service that creates an `invoice` row, and where it lives. */
const WRITERS = [
  "fees/fees.service.ts",
  "library/library.service.ts",
  "hostel/hostel.service.ts",
  "transport/transport.service.ts",
];

/** Missing is reported by the assertion below, never thrown at module load —
 *  a suite that fails to RUN reports `Tests: 0 total`, which is not a failure a
 *  reader can act on. */
const read = (rel: string) => {
  try { return stripComments(readFileSync(join(SRC, rel), "utf8")); } catch { return ""; }
};

/** The body of one named method, brace-matched — never a fixed window. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at === -1) return "";
  let i = src.indexOf("{", at);
  let depth = 0;
  const start = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/** The `data: { … }` block of each `invoice.create(...)` in a file. */
function invoiceCreateBlocks(src: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("invoice.create(", from);
    if (at === -1) break;
    // Walk to the matching close paren so the window is the CALL, never a
    // fixed character count — a fixed window is how a gate stops covering the
    // thing it names.
    let depth = 0;
    let i = src.indexOf("(", at);
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") { depth -= 1; if (depth === 0) break; }
    }
    blocks.push(src.slice(start, i + 1));
    from = i;
  }
  return blocks;
}

describe("an invoice is raised in the school's own currency", () => {
  const found = WRITERS.map((rel) => ({ rel, blocks: invoiceCreateBlocks(read(rel)) }));

  it("finds an invoice.create in every writer it names", () => {
    // A walk that finds nothing produces no offenders and passes silently.
    const empty = found.filter((f) => f.blocks.length === 0).map((f) => f.rel);
    expect(empty).toEqual([]);
  });

  it("never hard-codes the platform's currency on a new invoice", () => {
    // The exact defect: `currency: input.currency ?? "NGN"` with nothing in
    // between having asked the school.
    const offenders: string[] = [];
    for (const { rel, blocks } of found) {
      for (const b of blocks) {
        const m = b.match(/currency:\s*([^,\n]+)/);
        if (!m) continue;
        const expr = m[1];
        const namesTheSchool = /school\??\.?\w*[Cc]urrency|schoolCurrency|currency:\s*\w*[Cc]urrency/.test(expr);
        if (!namesTheSchool) offenders.push(`${rel}: currency: ${expr.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the school's currency inside the method that writes the row", () => {
    // BOUNDED TO THE METHOD. My first version asked the whole FILE, and
    // fees.service.ts resolves the school's currency elsewhere too (the late-fee
    // policy), so deleting the read from `createInvoice` left it green — a gate
    // one scope too WIDE fails exactly like one too narrow, and only mutation
    // tells them apart.
    const body = methodBody(read("fees/fees.service.ts"), "async createInvoice(");
    expect(body.length).toBeGreaterThan(400);
    expect(body).toMatch(/school\.findFirst\([\s\S]*?currency:\s*true/);
  });

  it("still lets a caller name a currency explicitly", () => {
    // Invoices carry their own currency per row on purpose: a school may raise
    // a bill in something other than its own, and an NGN invoice must keep
    // printing in naira whatever the school later switches to.
    const fees = read("fees/fees.service.ts");
    expect(fees).toMatch(/currency:\s*input\.currency\s*\?\?/);
  });
});
