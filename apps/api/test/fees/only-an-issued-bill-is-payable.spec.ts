// =============================================================================
// A family could be handed a live checkout page for a bill that did not exist
// =============================================================================
// `initInvoicePayment` tested three things: the invoice exists, the caller may
// see it, and the balance is above zero. It never asked whether the invoice was
// ISSUED. Proven against the running system with the demo parent — each of
// these answered 201 with a REAL Paystack authorization URL:
//
//   DRAFT      -> https://checkout.paystack.com/ttgat8m8wc9fimv
//   CANCELLED  -> https://checkout.paystack.com/nwagk4dqgejvcho
//
// A DRAFT is a bill still being written: the amount can change, lines can be
// added, it may never be sent. A CANCELLED one is a bill the school withdrew.
// Money taken against either settles through the ordinary webhook onto an
// invoice that was never owed — and the settlement path has no reason to
// question it, because posting a payment against an open invoice is exactly
// what it is for.
//
// The list had the other half of it: `listInvoices` applied NO default status
// filter, so a freshly created DRAFT appeared in the parent's own invoice list.
// That is where a parent would find the thing to pay.
// =============================================================================

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { stripComments } from "../support/strip-comments";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

/**
 * The body of `name`.
 *
 * // GOTCHA: taking the first `{` after the first `)` grabs the RETURN TYPE
 * when it is an object — `: Promise<{ items: unknown[] }>` — and the assertions
 * then run against a few characters of type annotation and fail for a reason
 * that has nothing to do with the code. Anchored on the brace that ENDS A LINE,
 * which is the body opener in this codebase's style.
 *
 * Comments are STRIPPED. Three assertions this session have passed or failed on
 * the prose EXPLAINING a fix rather than the fix — including one that matched
 * the word it was asserting the absence of, in its own comment.
 */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`async ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`no ${name}`);
  const open = src.indexOf("{\n", m.index);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) {
      return stripComments(src.slice(open, i));
    }
  }
  throw new Error("unterminated");
}

const PAY = bodyOf(SRC("fees/payment-gateway.service.ts"), "initInvoicePayment");
const LIST = bodyOf(SRC("fees/fees.service.ts"), "listInvoices");

describe("what may be paid", () => {
  it("refuses anything that is not an open, issued bill", () => {
    expect(PAY).toMatch(/inv\.status !== "ISSUED" && inv\.status !== "PARTIALLY_PAID"/);
  });

  it("checks the status BEFORE reaching the gateway", () => {
    // Otherwise the refusal depends on Paystack being configured, and on a
    // school where it is the charge simply happens.
    const guard = PAY.indexOf('inv.status !== "ISSUED"');
    expect(guard).toBeGreaterThan(-1);
    for (const call of ["paystack", "authorizationUrl", "initialize"]) {
      const at = PAY.indexOf(call);
      if (at > -1) expect([call, guard < at]).toEqual([call, true]);
    }
  });

  it("says WHICH problem it is, because the two need different actions", () => {
    // "Not yet issued" means wait for the school; "cancelled" means it is gone.
    expect(PAY).toMatch(/has not been issued yet/);
    expect(PAY).toMatch(/was cancelled/);
    expect(BadRequestException).toBeDefined();
  });

  it("keeps the balance check — a settled bill is still not payable", () => {
    expect(PAY).toMatch(/balance <= 0/);
  });
});

describe("what a family is shown", () => {
  it("excludes drafts from a non-billing-wide caller", () => {
    expect(LIST).toMatch(/status = opts\?\.status && opts\.status !== "DRAFT"/);
  });

  it("excludes them even when DRAFT is asked for by name", () => {
    // The first version of this fix only applied when no status was requested,
    // so `?status=DRAFT` handed back precisely what it was hiding.
    expect(LIST).toMatch(/\{ not: "DRAFT" \}/);
    expect(LIST).not.toMatch(/if \(!opts\?\.status\) where\.status = \{ not: "DRAFT" \}/);
  });

  it("leaves finance staff seeing everything, drafts included", () => {
    // A draft is a bill they are writing. The exclusion sits in the else-branch.
    const wide = LIST.indexOf("isBillingWide");
    const draft = LIST.indexOf('"DRAFT"');
    expect(wide).toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(wide);
  });

  it("keeps CANCELLED visible — withdrawn is history, not a secret", () => {
    // Deliberate: hiding it invites "what happened to that bill?". It is the
    // PAYING of it that is guarded, above.
    expect(LIST).not.toMatch(/CANCELLED/);
  });
});

describe("the errors it returns", () => {
  it("answers 404 for an invoice the caller may not see", () => {
    // Was a ForbiddenException whose MESSAGE said "not found" — the one
    // combination that confirms an invoice exists to somebody who may not see
    // it. CLAUDE.md: never leak existence.
    expect(PAY).toMatch(/if \(!inv\) throw new NotFoundException\("Invoice not found"\)/);
    expect(PAY).toMatch(/if \(!visible\) throw new NotFoundException\("Invoice not found"\)/);
    expect(NotFoundException).toBeDefined();
  });
});
