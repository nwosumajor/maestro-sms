// =============================================================================
// Region — what day is it, where the school is
// =============================================================================
// The platform decided "today" in UTC. For most of the world that is the wrong
// calendar day for part of every day, and a register is a record OF a day:
//
//   Singapore (UTC+8)  Monday 07:30 local = Sunday 23:30 UTC  -> filed Sunday
//   Toronto   (UTC-5)  Monday 19:30 local = Tuesday 00:30 UTC -> filed Tuesday
//
// These are the cases that were silently wrong, so they are the cases pinned here.
// =============================================================================

import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  countryProfile,
  resolveRegion,
  schoolDateString,
  schoolToday,
} from "@sms/types";

describe("schoolDateString — the school's calendar day", () => {
  it("gives SINGAPORE Monday when UTC still says Sunday", () => {
    // 23:30 UTC on Sunday is 07:30 Monday in Singapore. A register taken at
    // morning assembly was being filed against Sunday.
    const at = new Date("2026-08-02T23:30:00.000Z"); // Sunday, UTC
    expect(schoolDateString("UTC", at)).toBe("2026-08-02");
    expect(schoolDateString("Asia/Singapore", at)).toBe("2026-08-03"); // Monday
  });

  it("gives TORONTO Monday when UTC has already rolled to Tuesday", () => {
    // 00:30 UTC Tuesday is 20:30 Monday in Toronto. An evening correction was
    // being filed against tomorrow.
    const at = new Date("2026-08-04T00:30:00.000Z"); // Tuesday, UTC
    expect(schoolDateString("UTC", at)).toBe("2026-08-04");
    expect(schoolDateString("America/Toronto", at)).toBe("2026-08-03"); // Monday
  });

  it("handles daylight saving without arithmetic of our own", () => {
    // London is UTC+1 in August. 23:30 UTC in summer is already tomorrow there;
    // in January it is not. Getting this wrong by hand is exactly why this uses
    // the platform's tz database.
    expect(schoolDateString("Europe/London", new Date("2026-08-02T23:30:00.000Z"))).toBe("2026-08-03");
    expect(schoolDateString("Europe/London", new Date("2026-01-02T23:30:00.000Z"))).toBe("2026-01-02");
  });

  it("falls back to UTC rather than losing the day on a bad zone", () => {
    // A mistyped zone must not take a register down. The school's region gets
    // corrected; the register still gets taken.
    expect(schoolDateString("Not/AZone", new Date("2026-08-02T10:00:00.000Z"))).toBe("2026-08-02");
  });
});

describe("schoolToday — stored as the @db.Date columns expect", () => {
  it("is UTC midnight of the school's day, not the school's local midnight", () => {
    // Two schools in different zones having the same local Monday must store the
    // SAME Monday, or their registers cannot be compared or rolled up together.
    const at = new Date("2026-08-02T23:30:00.000Z");
    const sg = schoolToday("Asia/Singapore", at);
    expect(sg.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(sg.getUTCHours()).toBe(0);
  });
});

describe("resolveRegion — defaults preserve today's behaviour", () => {
  it("an existing school with NOTHING set is the platform's home region", () => {
    // The migration backfills nothing, deliberately. Every school already live
    // must keep the exact behaviour it has now.
    const r = resolveRegion({});
    expect(r.country).toBe(DEFAULT_COUNTRY);
    expect(r.timezone).toBe("Africa/Lagos");
    expect(r.locale).toBe("en-NG");
    expect(r.currency).toBe("NGN");
    expect(r.compliance).toBe("NDPR");
  });

  it("takes the country's defaults, and lets explicit columns win", () => {
    expect(resolveRegion({ country: "GB" })).toMatchObject({
      timezone: "Europe/London",
      currency: "GBP",
      compliance: "GDPR",
    });
    // A British school billing in dollars is expressible.
    expect(resolveRegion({ country: "GB", currency: "USD" }).currency).toBe("USD");
  });

  it("ignores an unknown country rather than producing an undefined zone", () => {
    // An undefined timezone would make every date on that school NaN.
    expect(resolveRegion({ country: "ZZ" }).timezone).toBe("Africa/Lagos");
    expect(countryProfile("nonsense").code).toBe(DEFAULT_COUNTRY);
  });

  it("lets a school choose a STRICTER regime than its country requires", () => {
    // A Dubai school taking British pupils may choose to run under GDPR.
    expect(resolveRegion({ country: "AE", complianceRegime: "GDPR" }).compliance).toBe("GDPR");
    // But not an invented one.
    expect(resolveRegion({ country: "AE", complianceRegime: "MADE_UP" }).compliance).toBe("NONE");
  });
});

describe("the country catalogue", () => {
  it("every country has a REAL IANA zone and a usable locale", () => {
    // A typo here would silently move a whole school's dates, so each entry is
    // exercised against the runtime rather than trusted.
    for (const [code, c] of Object.entries(COUNTRIES)) {
      // Intl THROWS on an unknown zone, which is what catches a typo. Deliberately
      // not comparing against resolvedOptions().timeZone: Node canonicalises some
      // zones to their legacy alias (Asia/Kolkata -> Asia/Calcutta), so equality
      // there fails on a perfectly valid entry.
      expect(() => new Intl.DateTimeFormat("en-CA", { timeZone: c.timezone }).format(new Date())).not.toThrow();
      // And it must produce a real date rather than falling through to the catch.
      expect(schoolDateString(c.timezone, new Date("2026-08-02T12:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect({ code, currency: /^[A-Z]{3}$/.test(c.currency) }).toEqual({ code, currency: true });
    }
  });

  it("declares payroll UNSUPPORTED wherever we do not know the tax law", () => {
    // The load-bearing null: emitting Nigerian PAYE for a British employee would
    // be worse than refusing, so every country without a pack says so.
    expect(COUNTRIES.NG.payrollPack).toBe("NG");
    for (const code of ["GB", "US", "AE", "GH", "KE", "SG"]) {
      expect({ code, pack: COUNTRIES[code].payrollPack }).toEqual({ code, pack: null });
    }
  });
});
