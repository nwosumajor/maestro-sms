// =============================================================================
// Granted is not credited
// =============================================================================
// An award is disbursed as a fees credit against the pupil's OPEN invoice. With
// no open invoice — the ordinary case when an award is decided before the term's
// fees are raised — `disburseFeesCredit` returns `{ ok: false, reason:
// "no_open_invoice" }`, nothing posts, and nothing retries.
//
// That is the right decision: the award STANDS rather than being thrown away
// over a posting problem, and the family is told the truth. What was missing is
// that the FUNDER could not see it. `disbursementPaymentId` was written to the
// row and appeared in no DTO, no endpoint and no screen — the same shape this
// codebase already records for `payment.platformFeeMinor`, "the owner who sets
// the rate had no way to see what it earned".
//
// And the operator's console asserted the opposite. Every AWARDED row read
// "Awarded X · fees credit posted." unconditionally. Measured on the demo
// tenant: FOUR awarded applications totalling NGN 800,000 with no payment, all
// four saying the credit was posted.
//
// Live after: disbursed=false on all four.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../../../web/components/operator/ScholarshipAdmin.tsx");
const DTO = join(__dirname, "../../../../packages/types/src/dto/scholarship.ts");

describe("an award that never reached a bill", () => {
  it("is a field the DTO actually carries", () => {
    // Written to the row and absent from every DTO is how this stayed invisible.
    expect(readFileSync(DTO, "utf8")).toMatch(/disbursed: boolean \| null;/);
  });

  it("distinguishes NOT AWARDED from AWARDED-BUT-NOT-CREDITED", () => {
    // Three states, not two. Collapsing "no award" and "award not credited" into
    // one falsy value reproduces the ambiguity the export bundle's coverage
    // manifest exists to remove, one module over.
    for (const f of ["src/scholarship/scholarship.service.ts", "src/scholarship/scholarship-admin.service.ts"]) {
      const src = readFileSync(join(__dirname, "../..", f), "utf8");
      // ANCHORED TO THE PROPERTY, not to the literal line. This matched the
      // exact source and went red when the award gained a SECOND way to be
      // disbursed (the credit ledger) — a change that preserves the three
      // states it exists to guard. What matters is that a non-AWARDED row
      // reports null, and that EITHER link counts as credited.
      const guarded =
        /disbursed:\s*\n?\s*r\.status === "AWARDED" \? Boolean\([^)]*\) : null/.test(src) &&
        /disbursementPaymentId \|\| r\.disbursementCreditEntryId/.test(src);
      expect({ f, guarded }).toEqual({ f, guarded: true });
    }
  });

  it("the funder's console no longer claims a credit was posted when it was not", () => {
    const src = readFileSync(WEB, "utf8");
    // The claim must be conditional on the fact.
    expect(src).toMatch(/a\.disbursed === false/);
    expect(src).toMatch(/NOT yet credited/);
    // And it must still say the true thing in the true case.
    expect(src).toMatch(/fees credit posted\./);
  });

  it("does not assert the credit unconditionally", () => {
    // The exact shipped line, which stated it as fact on every awarded row.
    const src = readFileSync(WEB, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/Awarded \{money\(a\.awardMinor\)\} · fees credit posted\./);
  });
});
