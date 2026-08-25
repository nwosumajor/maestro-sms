// =============================================================================
// A ledger line whose purpose you have to infer
// =============================================================================
// The operator's revenue ledger is the platform owner's record of what every
// school has paid it. It carried the plan, the cycle and the kind as three
// columns of raw enum codes and a single period END — so a finance desk reading
// it could not tell:
//
//   WHAT was sold   every add-on read "ADDON", though the row records WHICH
//                   module was bought in `addonModule`, and a five-year
//                   purchase was indistinguishable from a one-month renewal
//                   because `billingPeriods` never left the API
//   WHERE the school is   nothing carried the country, and `currency` is what
//                   the CHARGE was raised in — a Ghanaian school can be billed
//                   in USD, so the charge currency does not answer it
//   HOW LONG the money bought   only `periodEnd` was rendered; `periodStart`
//                   was in the DTO and dropped by the table
//   WHEN it was paid   the column headed "Date" was `createdAt`, the moment
//                   CHECKOUT STARTED. A charge begun on the 31st and settled on
//                   the 1st belongs to the new month, and the ledger filed it
//                   in the old one.
//
// Every one of those facts was already on the row in the database. None of them
// reached the screen.
// =============================================================================

import { describePlatformCharge } from "@sms/types";
import { OperatorPaymentsService } from "../../src/operator/operator-payments.service";

const OPERATOR = { userId: "u-owner", schoolId: "platform-org", roles: ["super_admin"], permissions: [] } as never;

function makeService(rows: Array<Record<string, unknown>>, schools: Array<Record<string, unknown>>) {
  const svc = Object.create(OperatorPaymentsService.prototype) as OperatorPaymentsService;
  Object.assign(svc, {
    audit: { record: jest.fn() },
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn({})) },
    privileged: {
      client: {
        platformSubscriptionPayment: {
          groupBy: jest.fn().mockResolvedValue([]),
          findMany: jest.fn().mockResolvedValue(rows),
          count: jest.fn().mockResolvedValue(rows.length),
        },
        messageCreditEntry: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
        school: { findMany: jest.fn().mockResolvedValue(schools) },
        user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", name: "Ada Bursar", email: "ada@school" }]) },
        $queryRaw: jest.fn().mockResolvedValue([]),
      },
    },
  });
  return svc;
}

const GHANA = { id: "s1", name: "Accra Grammar", country: "GH", currency: "GHS", timezone: "Africa/Accra" };
const base = {
  id: "p1",
  schoolId: "s1",
  reference: "PS-1",
  plan: "PREMIUM",
  billingCycle: "YEAR",
  seats: 240,
  amountMinor: 1_500_000,
  currency: "USD",
  status: "PAID",
  initiatedById: "u1",
  createdAt: new Date("2026-07-31T22:00:00Z"),
  paidAt: new Date("2026-08-01T06:00:00Z"),
  periodStart: new Date("2026-09-01T00:00:00Z"),
  periodEnd: new Date("2027-06-01T00:00:00Z"),
  billingPeriods: 1,
  arrearsMinor: 0,
  promoCode: null,
  addonModule: null,
};

describe("what a charge was FOR, in a sentence", () => {
  it("names the module on an add-on, which every one of them used to hide", () => {
    expect(
      describePlatformCharge({ kind: "ADDON", plan: "STANDARD", billingCycle: "TERM", addonModule: "HOSTEL" }),
    ).toContain("Add-on:");
    // The catalogue's label, not the raw key — the ledger should not need the
    // module catalogue open beside it.
    expect(describePlatformCharge({ kind: "ADDON", plan: "STANDARD", billingCycle: "TERM", addonModule: "LIBRARY" })).toMatch(
      /Add-on: \w/,
    );
  });

  it("says how many cycles a single charge bought", () => {
    // Five academic years is ONE charge and ONE row. Rendered as "YEAR" alone,
    // it was indistinguishable from a single year's renewal.
    const five = describePlatformCharge({ kind: "RENEWAL", plan: "ULTIMATE", billingCycle: "YEAR", billingPeriods: 5 });
    expect(five).toContain("5 years");
    expect(describePlatformCharge({ kind: "RENEWAL", plan: "ULTIMATE", billingCycle: "YEAR" })).toContain("1 year");
  });

  it("says a true-up moved the seats and NOT the period", () => {
    // Its tenor column is empty by design; without the sentence saying so, an
    // empty period reads as missing data.
    expect(describePlatformCharge({ kind: "TRUEUP", plan: "PREMIUM", billingCycle: "TERM", seats: 310 })).toContain(
      "period unchanged",
    );
  });

  it("says an upgrade restarts the period from today", () => {
    // Its tenor will not line up with the previous row's, which looks like an
    // error unless the line says why.
    expect(describePlatformCharge({ kind: "UPGRADE", plan: "ENTERPRISE", billingCycle: "YEAR" })).toContain("from today");
  });

  it("carries a promo code into the description", () => {
    expect(
      describePlatformCharge({ kind: "RENEWAL", plan: "STANDARD", billingCycle: "TERM", promoCode: "LAUNCH20" }),
    ).toContain("LAUNCH20");
  });
});

describe("the ledger row the operator actually reads", () => {
  it("dates the line by when the money ARRIVED, keeping the checkout date beside it", async () => {
    const [row] = (await makeService([base], [GHANA]).list(OPERATOR, {})).rows;
    // Started 31 July, settled 1 August. A book is kept on the second date.
    expect(row.paidAt?.toISOString()).toBe("2026-08-01T06:00:00.000Z");
    expect(row.createdAt.toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });

  it("says WHERE the school is, and what money IT keeps its books in", async () => {
    const [row] = (await makeService([base], [GHANA]).list(OPERATOR, {})).rows;
    // The country's NAME, not its code. And GHS — the school's own currency —
    // beside USD, the currency this charge was raised in. A ledger showing only
    // the charge currency cannot tell the two apart.
    expect(row.region).toEqual({ country: "Ghana", currency: "GHS", timezone: "Africa/Accra" });
    expect(row.currency).toBe("USD");
  });

  it("says how long the money bought", async () => {
    const [row] = (await makeService([base], [GHANA]).list(OPERATOR, {})).rows;
    expect(row.tenorDays).toBe(273); // 1 Sep -> 1 Jun
    expect(row.periodStart).not.toBeNull();
  });

  it("reports NO tenor for a charge that bought no time", async () => {
    // A seat top-up moves seats and never the period. Reporting the
    // subscription's existing window against it would count the same tenor
    // twice across two rows of the book.
    const trueup = { ...base, kind: "TRUEUP", periodStart: null, periodEnd: null };
    const [row] = (await makeService([trueup], [GHANA]).list(OPERATOR, {})).rows;
    expect(row.tenorDays).toBeNull();
    expect(row.purpose).toContain("period unchanged");
  });

  it("attributes the charge to whoever started it", async () => {
    const [row] = (await makeService([base], [GHANA]).list(OPERATOR, {})).rows;
    expect(row.initiatedBy).toEqual({ name: "Ada Bursar", email: "ada@school" });
  });

  it("says when part of the amount was money already owed", async () => {
    // Arrears are INCLUDED in the charge, not additional. A ledger that does
    // not say so reports settled debt as new revenue in the month it lands.
    const withArrears = { ...base, arrearsMinor: 250_000 };
    const [row] = (await makeService([withArrears], [GHANA]).list(OPERATOR, {})).rows;
    expect(row.arrearsMinor).toBe(250_000);
    expect(row.amountMinor).toBe(1_500_000);
  });

  it("falls back to the country CODE rather than to a blank", async () => {
    const unknown = { ...GHANA, country: "ZZ" };
    const [row] = (await makeService([base], [unknown]).list(OPERATOR, {})).rows;
    expect(row.region.country).toBe("ZZ");
  });

  it("treats a school with no region as the platform's home currency", async () => {
    const noRegion = { id: "s1", name: "Lagos High", country: null, currency: null, timezone: null };
    const [row] = (await makeService([base], [noRegion]).list(OPERATOR, {})).rows;
    expect(row.region).toEqual({ country: null, currency: "NGN", timezone: null });
  });
});
