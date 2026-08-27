// =============================================================================
// The operator console rendered a school's money in the platform's naira
// =============================================================================
// `money()` in the web defaults to `PLATFORM_REGION.currency`. On the operator's
// cross-tenant views two figures were rendered with no currency at all:
//
//   money(s.outstandingMinor)          seat arrears — in the BILLING currency
//   money(s.admissionFormFeeMinor)     the school's OWN fee currency
//
// The subscription price beside them passes one (`money(s.priceMinor,
// s.currency)`) and so does each payment row (`money(pmt.amountMinor,
// pmt.currency)`) — so the page got it right twice and wrong twice.
//
// The two are NOT the same currency, which is the part that makes this more than
// a missing argument: a school pays the platform in one currency and bills its
// families in another. CLAUDE.md states it plainly — "a Ghanaian school can be
// billed in USD". The DTO's `currency` field is the SUBSCRIPTION's, and using it
// for the admission fee would have been a second wrong answer.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";

const WEB = join(__dirname, "../../../web/app/(app)/operator/schools");
const DTO = readFileSync(join(__dirname, "../../../../packages/types/src/dto/operator.ts"), "utf8");
const SERVICE = readFileSync(join(__dirname, "../../src/operator/operator-directory.service.ts"), "utf8");

const profile = readFileSync(join(WEB, "[id]/page.tsx"), "utf8");
const list = readFileSync(join(WEB, "page.tsx"), "utf8");

describe("a school's money says which money it is", () => {
  it("never renders a school figure with the platform's default currency", () => {
    // A bare `money(x)` on a cross-tenant page is the defect: it silently means
    // "the platform's currency", which is right for the platform's own revenue
    // and wrong for anything belonging to a school.
    for (const [name, src] of [["profile", profile], ["list", list]] as const) {
      const bare = [...src.matchAll(/money\(s\.\w+Minor\)/g)].map((m) => m[0]);
      expect({ page: name, bare }).toEqual({ page: name, bare: [] });
    }
  });

  it("names the two currencies separately, because they are not the same one", () => {
    // Arrears are in what the school PAYS the platform; the admission fee is in
    // what the school CHARGES families.
    expect(DTO).toMatch(/outstandingCurrency: string;/);
    expect(DTO).toMatch(/feeCurrency: string;/);
    expect(profile).toMatch(/money\(s\.outstandingMinor, s\.outstandingCurrency\)/);
    expect(profile).toMatch(/money\(s\.admissionFormFeeMinor, s\.feeCurrency\)/);
    expect(list).toMatch(/money\(s\.outstandingMinor, s\.outstandingCurrency\)/);
  });

  it("reads both from the database rather than assuming either", () => {
    // A select that omits them makes the DTO fields undefined, and `money()`
    // falls straight back to the platform default — the same bug, silently.
    expect(SERVICE).toMatch(/currency: true/);
    expect(SERVICE).toMatch(/outstandingCurrency:/);
    expect(SERVICE).toMatch(/feeCurrency:/);
  });

  it("falls back to the school's own currency, never to a hard-coded one", () => {
    // `resolveRegion` is how every other read resolves a null column: it means
    // the platform's HOME currency for a school that predates the region model,
    // which is what such a school has always billed in.
    expect(SERVICE).toMatch(/resolveRegion\(/);
    expect(SERVICE).not.toMatch(/outstandingCurrency:\s*"NGN"/);
  });
});
