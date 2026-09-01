// =============================================================================
// Paying a cancelled invoice brought it back to life
// =============================================================================
// #255 stopped a checkout being STARTED against a DRAFT or CANCELLED invoice.
// It cannot stop one already in flight, and that is the ordinary case:
//
//   1. a parent opens the checkout while the invoice is ISSUED
//   2. the school cancels it — wrong amount, duplicate bill, the pupil left
//   3. the parent completes payment on the page still open in front of them
//   4. the webhook settles it
//
// `applyOnlinePayment` checked that the invoice existed, that the currency
// matched, and that the reference was not already posted. It never asked
// whether the invoice was still OPEN — and look at what it does at the end:
//
//     const status = paid >= inv.totalMinor ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "ISSUED";
//     await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
//
// It computes a status from the payments and WRITES IT OVER whatever the
// invoice had. So the settlement does not merely record money in an odd place;
// it RESURRECTS a cancellation the school made deliberately, as PAID.
//
// This is the ONE posting path for every rail — card, mobile money, virtual
// account, verify-on-return and the reconciliation sweep — so one guard covers
// all of them, exactly as the currency check above it does.
//
// REFUSED rather than posted, for the reason that currency check gives in its
// own comment: refusing leaves the money unposted and recoverable by hand,
// posting is not, because nothing downstream revisits a settled invoice.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/fees/settlement.service.ts"), "utf8");
/** Comments stripped — an assertion must not match the prose explaining it. */
const CODE = stripComments(SRC);

describe("settling onto an invoice that is not open", () => {
  it("is refused", () => {
    expect(CODE).toMatch(/inv\.status !== "ISSUED" && inv\.status !== "PARTIALLY_PAID"/);
    expect(CODE).toMatch(/invoice_not_open/);
  });

  it("is refused BEFORE the payment row is created", () => {
    const guard = CODE.indexOf('inv.status !== "ISSUED"');
    const create = CODE.indexOf("tx.payment.create");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
  });

  it("is refused BEFORE the invoice status is rewritten", () => {
    // The actual damage: `data: { status }` over a CANCELLED invoice.
    const guard = CODE.indexOf('inv.status !== "ISSUED"');
    expect(guard).toBeLessThan(CODE.indexOf("tx.invoice.update"));
  });

  it("carries the status through, so the alert can name it", () => {
    // "not open" is not actionable; "cancelled" and "draft" need different
    // things done about them.
    expect(CODE).toMatch(/kind: "invoice_not_open" as const, status: inv\.status/);
  });

  it("is a distinct outcome, not folded into an existing one", () => {
    // Reusing `invoice_missing` would tell a reconciler to look for an invoice
    // that is sitting right there.
    expect(CODE).toMatch(/\| "invoice_not_open"/);
  });
});

describe("what happens to the money", () => {
  it("tells finance, not just the log", () => {
    // The recurring failure in this codebase: recorded faithfully somewhere
    // nobody reads. A refusal means a payer may be out of pocket with nothing
    // on the ledger, which is a same-day problem for a person, not a log line.
    expect(CODE).toMatch(/private async refuse\(/);
    expect(CODE).toMatch(/notifications\.enqueue\(/);
    expect(CODE).toMatch(/FINANCE_ROLES/);
  });

  it("still logs loudly", () => {
    expect(CODE).toMatch(/logger\.error\(`settlement REFUSED/);
  });

  it("uses the same refusal path for the currency mismatch", () => {
    // That one was log-only too. One helper, so neither can drift into being
    // quieter than the other.
    const refusals = CODE.match(/await this\.refuse\(/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(2);
  });

  it("never lets a failed alert undo the refusal", () => {
    // The alert is best-effort; the log line is the record of last resort.
    const at = CODE.indexOf("private async refuse(");
    expect(CODE.slice(at, at + 1200)).toMatch(/catch/);
  });
});

describe("what must still work", () => {
  it("keeps posting onto an ISSUED or PARTIALLY_PAID invoice", () => {
    // The guard names both, so a part-paid invoice can still be topped up.
    expect(CODE).toMatch(/!== "ISSUED" && inv\.status !== "PARTIALLY_PAID"/);
  });

  it("keeps the idempotency guard ahead of the write", () => {
    expect(CODE.indexOf('"duplicate"')).toBeLessThan(CODE.indexOf("tx.payment.create"));
  });

  it("keeps the currency guard", () => {
    expect(CODE).toMatch(/inv\.currency !== input\.currency/);
  });
});
