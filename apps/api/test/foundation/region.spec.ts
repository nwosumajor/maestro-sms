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
  hasPayrollPack,
  DEFAULT_COUNTRY,
  countryProfile,
  resolveRegion,
  schoolDateString,
  schoolMinutesOfDay,
  schoolToday,
  complianceProfile,
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


describe("schoolMinutesOfDay — the clock a person there is reading", () => {
  // The companion to schoolDateString, added because three staff-attendance
  // comparisons were asking the SERVER what time it was. `lateAfter`,
  // `windowStart` and `windowEnd` are wall-clock times a school configured, so
  // they can only be judged against that school's clock.
  const instant = new Date("2026-08-17T23:30:00.000Z");

  it("reads the same instant differently in each zone", () => {
    expect(schoolMinutesOfDay("Asia/Singapore", instant)).toBe(7 * 60 + 30); // 07:30 next day
    expect(schoolMinutesOfDay("Africa/Lagos", instant)).toBe(0 * 60 + 30); // 00:30 next day
    expect(schoolMinutesOfDay("America/Toronto", instant)).toBe(19 * 60 + 30); // 18:30 same day (EDT)
    expect(schoolMinutesOfDay("UTC", instant)).toBe(23 * 60 + 30);
  });

  it("normalises midnight to 0, not 1440", () => {
    // Some runtimes render midnight as 24 under en-GB; a 24:00 reading would put
    // every midnight event past any configured boundary.
    expect(schoolMinutesOfDay("UTC", new Date("2026-08-17T00:00:00.000Z"))).toBe(0);
    expect(schoolMinutesOfDay("UTC", new Date("2026-08-17T00:07:00.000Z"))).toBe(7);
  });

  it("follows daylight saving via the tz database, not arithmetic", () => {
    // Toronto is UTC-4 in August and UTC-5 in January. A fixed offset would get
    // one of these wrong.
    expect(schoolMinutesOfDay("America/Toronto", new Date("2026-08-17T16:00:00.000Z"))).toBe(12 * 60);
    expect(schoolMinutesOfDay("America/Toronto", new Date("2026-01-17T17:00:00.000Z"))).toBe(12 * 60);
  });

  it("falls back to UTC on an unusable zone rather than throwing", () => {
    // Same posture as the date helper: a bad region must not take the kiosk down.
    expect(schoolMinutesOfDay("Not/AZone", instant)).toBe(23 * 60 + 30);
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
    // But not an invented one — it falls back to the country's own regime,
    // which for a country whose law we do not model is UNSPECIFIED ("we do not
    // know your obligations"), never a claim that none apply.
    expect(resolveRegion({ country: "AE", complianceRegime: "MADE_UP" }).compliance).toBe("UNSPECIFIED");
    expect(complianceProfile(resolveRegion({ country: "AE", complianceRegime: "MADE_UP" }).compliance).modelled).toBe(false);
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

  it("every declared payroll pack ACTUALLY EXISTS", () => {
    // The invariant that survives adding countries: a country either names a pack
    // that is implemented, or declares null. A country naming a pack that does not
    // exist would pass region validation and then throw at payroll time, which is
    // the wrong place to find out.
    for (const [code, c] of Object.entries(COUNTRIES)) {
      expect({ code, ok: c.payrollPack === null || hasPayrollPack(c.payrollPack) }).toEqual({ code, ok: true });
    }
  });

  it("declares payroll UNSUPPORTED wherever we do not know the tax law", () => {
    // The load-bearing null: emitting Nigerian PAYE for an Emirati employee would
    // be worse than refusing, so every country without a pack says so. Nigeria and
    // the UK are implemented; the rest are not, and say it.
    expect(COUNTRIES.NG.payrollPack).toBe("NG");
    expect(COUNTRIES.GB.payrollPack).toBe("GB");
    for (const code of ["US", "AE", "GH", "KE", "SG", "IN", "CA", "ZA", "IE", "SA"]) {
      expect({ code, pack: COUNTRIES[code].payrollPack }).toEqual({ code, pack: null });
    }
  });
});
