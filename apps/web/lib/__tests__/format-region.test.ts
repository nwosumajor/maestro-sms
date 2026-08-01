// =============================================================================
// Region-aware formatters
// =============================================================================
// Two things were wrong before, and both are pinned here:
//
//   1. Everything rendered in en-NG / Africa/Lagos for every school on the
//      platform. A parent in Dubai read their child's dates in West Africa Time
//      and their fees with a ₦ in front.
//
//   2. CALENDAR DATES ARE NOT TIMESTAMPS. A `@db.Date` is midnight UTC and means a
//      DAY. Naively rendering one in the school's zone shows the PREVIOUS day
//      anywhere west of UTC — so "fix the timezone" done carelessly would have
//      dated every register in Toronto a day early. That is the trap this file
//      exists to keep shut.
// =============================================================================

import { PLATFORM_REGION, dateTime, formattersFor, money, regionOf, shortDate } from "../format";

const LAGOS = { locale: "en-NG", timezone: "Africa/Lagos", currency: "NGN" };
const TORONTO = { locale: "en-CA", timezone: "America/Toronto", currency: "CAD" };
const LONDON = { locale: "en-GB", timezone: "Europe/London", currency: "GBP" };

describe("calendar dates vs timestamps", () => {
  // Exactly midnight UTC — what a @db.Date column serialises to.
  const registerDay = "2026-08-03T00:00:00.000Z";

  it("renders a CALENDAR DATE as the same day everywhere", () => {
    // The trap: America/Toronto is UTC-4 in August, so converting this instant to
    // local time lands on 2 August. A register taken on the 3rd must not read as
    // the 2nd because of where the school is.
    for (const region of [LAGOS, TORONTO, LONDON]) {
      expect(shortDate(registerDay, region)).toContain("3");
      expect(shortDate(registerDay, region)).not.toContain(" 2,");
    }
  });

  it("renders a TIMESTAMP in the school's own zone", () => {
    // 23:30 UTC is 19:30 the same day in Toronto and 00:30 the NEXT day in Lagos.
    const at = "2026-08-03T23:30:00.000Z";
    expect(dateTime(at, TORONTO)).toContain("3");
    expect(dateTime(at, LAGOS)).toContain("4");
  });

  it("still uses the school's zone for a timestamp that is merely early", () => {
    // 00:30 UTC is not midnight, so it is an instant, not a calendar date: Toronto
    // is still on the previous evening.
    const at = "2026-08-03T00:30:00.000Z";
    expect(dateTime(at, TORONTO)).toContain("2");
  });
});

describe("money", () => {
  it("formats in the given currency, not the platform's", () => {
    expect(money(150_00, "GBP", "en-GB")).toContain("£");
    expect(money(150_00, "USD", "en-US")).toContain("$");
    expect(money(150_00, "NGN", "en-NG")).toContain("₦");
  });

  it("falls back to a readable string rather than blank on a bad currency", () => {
    // A school with a mistyped currency must still see the number.
    expect(money(150_00, "NOTACCY")).toMatch(/NOTACCY\s*150\.00/);
  });

  it("defaults to the platform's currency when none is given", () => {
    expect(money(100_00)).toContain("₦");
  });
});

describe("regionOf — old sessions keep working", () => {
  it("falls back to the platform's home when the session carries nothing", () => {
    // Sessions minted before the region existed must not render blank.
    expect(regionOf(undefined)).toEqual(PLATFORM_REGION);
    expect(regionOf({})).toEqual(PLATFORM_REGION);
  });

  it("uses the school's values when present", () => {
    expect(regionOf({ locale: "en-GB", timezone: "Europe/London", currency: "GBP" })).toEqual(LONDON);
  });

  it("fills only the missing pieces", () => {
    // A school that set a currency but no zone keeps the platform's zone rather
    // than getting undefined, which would make every date NaN.
    expect(regionOf({ currency: "GBP" })).toEqual({ ...PLATFORM_REGION, currency: "GBP" });
  });
});

describe("formattersFor", () => {
  it("binds the school's currency without having to pass it every time", () => {
    const f = formattersFor(LONDON);
    expect(f.money(2_50)).toContain("£");
    // An explicit currency still wins — an invoice raised in another currency
    // must print in the currency it was raised in.
    expect(f.money(2_50, "USD")).toContain("$");
  });

  it("handles null and invalid dates rather than throwing", () => {
    const f = formattersFor(LONDON);
    expect(f.shortDate(null)).toBe("—");
    expect(f.dateTime("not a date")).toBe("—");
  });
});
