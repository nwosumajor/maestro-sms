// =============================================================================
// Paying a school into its OWN bank, outside Nigeria
// =============================================================================
// Splitting fees to a school's account needs a Paystack subaccount, and creating
// one needs three country-specific things: the right bank list, an account
// number in that country's shape, and — the part that keeps the money safe —
// the ability to resolve that account to a NAME the school reads back.
//
// The platform had none of them, and every failure was silent:
//
//   * `listBanks(country = "nigeria")` was called with NO argument from the one
//     place that matters. Verified live against a real key: a school set to
//     Ghana was offered 279 NIGERIAN banks — "9jaPay Microfinance Bank",
//     "9mobile 9Payment Service Bank" — and not one Ghanaian bank. Paystack
//     serves the right list per country (ghana 57, kenya 99, south africa 33)
//     and was simply never asked.
//   * the account number was checked against `/^\d{10}$/`, a Nigerian NUBAN, in
//     both places that take one, so a Ghanaian or Kenyan school could not save
//     an account even if it found its bank.
//
// So a school inside Paystack's coverage could not configure settlement at all,
// while its parents' fees were collected and held in the PLATFORM's account
// flagged `settledToPlatform`.
//
// And one more, found by asking the rail instead of reading the docs:
//
//   * `PAYSTACK_CURRENCIES` describes what PAYSTACK supports. It was being used
//     as though it described what THIS MERCHANT ACCOUNT supports. Verified live:
//
//         NGN  200 accepted
//         GHS  403 Currency not supported by merchant
//         KES  403 Currency not supported by merchant
//         ZAR  403 Currency not supported by merchant
//         USD  403 Currency not supported by merchant
//
//     A Ghanaian school's GHS invoice passed the static check, was routed to
//     Paystack, and the parent met a raw gateway refusal at checkout — while the
//     "use mobile money instead" message that exists for exactly this never
//     fired, because GHS is in the list.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAYSTACK_COUNTRIES,
  PAYSTACK_CURRENCIES,
  paystackCanSettleCountry,
  paystackCountry,
  paystackSettlementBlocker,
} from "@sms/types";

const GATEWAY = readFileSync(join(__dirname, "../../src/fees/payment-gateway.service.ts"), "utf8");
const PAYSTACK_SRC = readFileSync(join(__dirname, "../../src/payments/paystack.service.ts"), "utf8");
const CARD = readFileSync(join(__dirname, "../../../web/components/fees/SettlementAccountCard.tsx"), "utf8");

describe("the country a school actually banks in", () => {
  it("has its own Paystack slug, so the right bank list can be asked for", () => {
    // Verified live: these are the slugs Paystack's /bank endpoint answers to.
    expect(paystackCountry("GH")?.slug).toBe("ghana");
    expect(paystackCountry("KE")?.slug).toBe("kenya");
    expect(paystackCountry("ZA")?.slug).toBe("south africa");
    expect(paystackCountry("NG")?.slug).toBe("nigeria");
  });

  it("decides the bank list, rather than a default of Nigeria", () => {
    const fn = GATEWAY.slice(GATEWAY.indexOf("async listSettlementBanks("), GATEWAY.indexOf("private async settlementCountry"));
    expect(fn).toMatch(/listBanks\(country!\.slug\)/);
    expect(fn).not.toMatch(/listBanks\(\)/);
  });

  it("decides the account number's shape, rather than a Nigerian NUBAN", () => {
    // The old rule, in both places that take an account number.
    expect(GATEWAY).not.toMatch(/\/\^\\d\{10\}\$\/\.test\(input\.accountNumber\)/);
    expect(GATEWAY).toMatch(/assertAccountNumberShape/);
  });

  it("is unknown for a country Paystack does not bank in, and says so", () => {
    expect(paystackCountry("UG")).toBeNull();
    expect(paystackSettlementBlocker("UG")).toMatch(/mobile money/i);
  });
});

describe("an account nobody could verify is never set up", () => {
  it("refuses South Africa, where the name cannot be resolved", () => {
    // Verified live: Paystack answers 400 "Please supply one of the following
    // valid currencies: NGN, USD, GHS, KES" for a South African bank code. ZAR
    // is not among them, so the one check that catches a transposed digit
    // cannot be performed — and a subaccount nobody verified is exactly the
    // failure this whole flow exists to prevent.
    expect(paystackCanSettleCountry("ZA")).toBe(false);
    expect(paystackSettlementBlocker("ZA")).toMatch(/cannot confirm the account holder's name/i);
  });

  it("allows the three countries where it can be", () => {
    for (const code of ["NG", "GH", "KE"]) {
      expect([code, paystackCanSettleCountry(code)]).toEqual([code, true]);
      expect([code, paystackSettlementBlocker(code)]).toEqual([code, null]);
    }
  });

  it("still reads the name back and makes the school confirm it", () => {
    // Unchanged and load-bearing: creating a subaccount proves an account
    // EXISTS, never whose it is.
    expect(GATEWAY).toMatch(/normaliseAccountName\(input\.confirmedAccountName\)/);
    expect(GATEWAY).toMatch(/resolveAccount\(input\.bankCode, input\.accountNumber\)/);
  });

  it("never lists a settleable country whose name resolution does not work", () => {
    for (const c of PAYSTACK_COUNTRIES) {
      if (paystackCanSettleCountry(c.code)) {
        expect([c.code, c.canResolveAccountName]).toEqual([c.code, true]);
      }
    }
  });
});

describe("what the merchant account can actually charge", () => {
  it("is asked of the account, not read off a constant", () => {
    expect(PAYSTACK_SRC).toMatch(/async merchantCurrencies\(\)/);
    expect(PAYSTACK_SRC).toMatch(/\$\{PAYSTACK\}\/balance/);
  });

  it("falls back rather than blocking when it cannot be determined", () => {
    // An unreachable /balance must never be the reason a working school stops
    // collecting fees.
    const fn = PAYSTACK_SRC.slice(
      PAYSTACK_SRC.indexOf("async merchantCurrencies()"),
      PAYSTACK_SRC.indexOf("async createSubaccount("),
    );
    expect(fn).toMatch(/return this\.currencyCache\?\.currencies \?\? null/);
  });

  it("is a NARROWER question than what Paystack supports", () => {
    // The static list is still right about the provider; it was only ever wrong
    // as an answer about one account.
    expect(PAYSTACK_CURRENCIES).toEqual(expect.arrayContaining(["NGN", "GHS", "ZAR", "KES", "USD"]));
  });

  it("turns the rail's refusal into something somebody can act on", () => {
    const init = PAYSTACK_SRC.slice(PAYSTACK_SRC.indexOf("async initialize("), PAYSTACK_SRC.indexOf("chargeAuthorization"));
    expect(init).toMatch(/currency not supported by merchant/i);
    expect(init).toMatch(/mobile money/i);
    // And never swallows the rail's own words behind a generic message.
    expect(init).toMatch(/Payment provider error: \$\{detail\}/);
  });
});

describe("the school is told before it fills the form in", () => {
  it("states why settlement is unavailable, up front", () => {
    expect(CARD).toMatch(/initial\.blockedReason/);
    expect(CARD).toMatch(/Settlement to a bank is not available for your country/);
  });

  it("names the currency the account cannot charge", () => {
    expect(CARD).toMatch(/merchantCanChargeCurrency === false/);
    expect(CARD).toMatch(/not enabled/);
  });

  it("stops calling every school's account a NUBAN", () => {
    expect(CARD).toMatch(/initial\.accountLabel/);
    expect(CARD).not.toMatch(/Account number \(NUBAN\)/);
    expect(CARD).not.toMatch(/\/\^\\d\{10\}\$\/\.test\(accountNumber\)/);
  });
});
