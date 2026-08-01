// =============================================================================
// Mobile-money coverage and MSISDN normalisation — the data-driven half
// =============================================================================
// The design bet is that adding a country is a ROW, not a branch. These tests pin
// that the table is internally consistent, so a bad row is caught here rather than
// by a parent whose payment prompt never arrives.
// =============================================================================

import {
  COUNTRIES,
  MOBILE_MONEY_COVERAGE,
  coverageFor,
  coverageOf,
  currencyDecimals,
  hasMobileMoney,
  normaliseMsisdn,
} from "@sms/types";

describe("the coverage table", () => {
  it("names a country the platform actually knows, with ITS currency", () => {
    // A row whose currency disagrees with the country catalogue would produce an
    // invoice the rail refuses at charge time — a failure the payer discovers.
    for (const c of MOBILE_MONEY_COVERAGE) {
      const country = COUNTRIES[c.country];
      expect({ row: `${c.provider}/${c.country}`, known: !!country }).toEqual({
        row: `${c.provider}/${c.country}`,
        known: true,
      });
      expect({ row: `${c.provider}/${c.country}`, currency: c.currency }).toEqual({
        row: `${c.provider}/${c.country}`,
        currency: country.currency,
      });
    }
  });

  it("has a plausible dial code on every row", () => {
    for (const c of MOBILE_MONEY_COVERAGE) {
      expect({ row: c.country, dial: /^\d{1,4}$/.test(c.dialCode) }).toEqual({ row: c.country, dial: true });
    }
  });

  it("covers the zero-decimal markets, which is where the money bug bit hardest", () => {
    // XOF/XAF/RWF/UGX have no subdivision — the rails take major units, so this is
    // the coverage that depends on `toMajor` asking the currency.
    const zero = MOBILE_MONEY_COVERAGE.filter((c) => currencyDecimals(c.currency) === 0);
    expect(zero.map((c) => c.country)).toEqual(expect.arrayContaining(["UG", "CM", "CI", "RW"]));
  });

  it("answers the same question the same way everywhere", () => {
    expect(hasMobileMoney("KE")).toBe(true);
    expect(hasMobileMoney("GB")).toBe(false);
    expect(coverageFor("KE").length).toBeGreaterThan(1); // M-Pesa and Airtel
    expect(coverageOf("MPESA", "KE")?.currency).toBe("KES");
    expect(coverageOf("MPESA", "GH")).toBeNull(); // M-Pesa does not operate there
  });
});

describe("normaliseMsisdn — a parent types whatever their phone shows them", () => {
  it("accepts the local, international and plus forms alike", () => {
    for (const typed of ["0712345678", "712345678", "254712345678", "+254 712 345 678"]) {
      expect({ typed, msisdn: normaliseMsisdn(typed, "254") }).toEqual({ typed, msisdn: "254712345678" });
    }
  });

  it("strips spaces, dashes and brackets", () => {
    expect(normaliseMsisdn("(024) 123-4567", "233")).toBe("233241234567");
  });

  it("refuses something that cannot be a number", () => {
    // Better a clear rejection than a prompt sent into the void.
    expect(normaliseMsisdn("12", "254")).toBeNull();
    expect(normaliseMsisdn("", "254")).toBeNull();
    expect(normaliseMsisdn("abc", "254")).toBeNull();
  });
});
