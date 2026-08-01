// =============================================================================
// Currency scale — the bug that made money 100× wrong across much of Africa
// =============================================================================
// The platform stores money as integer MINOR units and divided by 100 everywhere.
// That is right for the naira, cedi, shilling, rand, pound and dollar — and wrong
// for the CFA franc, which has no centime, and for several other African
// currencies with no subdivision at all.
//
//     stored 150000   NGN -> ₦1,500.00       correct
//     stored 150000   XOF -> F CFA 1,500     WRONG — the amount is 150,000
//
// A school fee displayed at a hundredth of its value is bad; a GATEWAY asked to
// charge a hundredth of it is worse. These tests pin the scale per currency, and
// pin that every country in the catalogue round-trips.
// =============================================================================

import {
  COUNTRIES,
  currencyDecimals,
  formatMoney,
  isZeroDecimal,
  minorUnits,
  toMajor,
  toMinor,
} from "@sms/types";

const ZERO_DECIMAL = ["XOF", "XAF", "RWF", "UGX", "BIF", "DJF", "GNF", "KMF"];
const TWO_DECIMAL = ["NGN", "GHS", "KES", "ZAR", "USD", "GBP", "EUR", "EGP"];

describe("currency scale", () => {
  it("knows the CFA franc has no subdivision", () => {
    for (const c of ZERO_DECIMAL) {
      expect({ c, decimals: currencyDecimals(c) }).toEqual({ c, decimals: 0 });
      expect({ c, units: minorUnits(c) }).toEqual({ c, units: 1 });
      expect(isZeroDecimal(c)).toBe(true);
    }
  });

  it("keeps 100 minor units where a currency has them", () => {
    for (const c of TWO_DECIMAL) {
      expect({ c, units: minorUnits(c) }).toEqual({ c, units: 100 });
      expect(isZeroDecimal(c)).toBe(false);
    }
  });

  it("formats the SAME stored integer correctly in both kinds", () => {
    // The regression, stated as plainly as it can be.
    expect(formatMoney(150_000, "NGN", "en")).toContain("1,500");
    expect(formatMoney(150_000, "XOF", "en")).toContain("150,000");
  });

  it("round-trips a major amount through storage without drift", () => {
    for (const c of [...ZERO_DECIMAL, ...TWO_DECIMAL]) {
      const typed = 2_500; // what a bursar types
      expect({ c, back: toMajor(toMinor(typed, c), c) }).toEqual({ c, back: typed });
    }
  });

  it("rounds rather than storing a fractional minor unit", () => {
    // You cannot charge half a kobo, and you certainly cannot charge half a franc
    // that has no subdivision.
    expect(toMinor(10.005, "NGN")).toBe(1001);
    expect(toMinor(10.4, "XOF")).toBe(10);
    expect(Number.isInteger(toMinor(10.6, "XOF"))).toBe(true);
  });

  it("falls back to two decimals for a currency the runtime does not know", () => {
    // Never throw and never render blank: a mistyped code must still show a number.
    expect(currencyDecimals("ZZZ")).toBe(2);
    expect(formatMoney(150_000, "ZZZ")).toMatch(/ZZZ\s*1,?500\.00/);
  });
});

describe("the country catalogue", () => {
  it("covers Africa broadly, and every currency is a real ISO code", () => {
    const african = Object.values(COUNTRIES).filter((c) => c.timezone.startsWith("Africa/"));
    expect(african.length).toBeGreaterThanOrEqual(25);
    for (const c of african) {
      expect({ code: c.code, currency: /^[A-Z]{3}$/.test(c.currency) }).toEqual({ code: c.code, currency: true });
      // Every one must format without throwing — a country whose currency the
      // runtime rejects would break every money field on that school's pages.
      expect(() => formatMoney(1_000, c.currency, c.locale)).not.toThrow();
    }
  });

  it("includes the zero-decimal countries that were previously wrong", () => {
    // The franc zone is the point of this change: eleven catalogue entries whose
    // money was out by a factor of a hundred.
    const zero = Object.values(COUNTRIES).filter((c) => isZeroDecimal(c.currency));
    expect(zero.map((c) => c.code)).toEqual(expect.arrayContaining(["SN", "CI", "CM", "RW", "UG"]));
  });

  it("declares payroll unimplemented for every African country except Nigeria", () => {
    // Honest by construction: statutory rules differ per country and only Nigeria's
    // are written, so the rest refuse rather than borrowing them.
    for (const c of Object.values(COUNTRIES).filter((x) => x.timezone.startsWith("Africa/"))) {
      const expected = c.code === "NG" ? "NG" : null;
      expect({ code: c.code, pack: c.payrollPack }).toEqual({ code: c.code, pack: expected });
    }
  });
});
