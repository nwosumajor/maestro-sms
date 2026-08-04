// =============================================================================
// Academic-calendar pure helpers — validation, standard-session, teaching days
// =============================================================================

import { defaultSessionFor, pickOpeningTerm, countryProfile } from "@sms/types";
import {
  countTeachingDays,
  isHoliday,
  isTeachingDay,
  standardTermDates,
  validateSessionDates,
  validateTermDates,
} from "@sms/types";

describe("validateTermDates", () => {
  const session = { id: "s1", startDate: "2025-09-01", endDate: "2026-07-31" };

  it("accepts a well-formed term inside its session with a free sequence", () => {
    expect(validateTermDates({ sequence: 1, startDate: "2025-09-01", endDate: "2025-12-12" }, session, [])).toBeNull();
  });

  it("rejects end before start", () => {
    expect(validateTermDates({ sequence: 1, startDate: "2025-12-12", endDate: "2025-09-01" }, session, [])).toMatch(/end date cannot be before/i);
  });

  it("rejects a term starting before its session", () => {
    expect(validateTermDates({ sequence: 1, startDate: "2025-08-01", endDate: "2025-12-12" }, session, [])).toMatch(/before its session/i);
  });

  it("rejects a term ending after its session", () => {
    expect(validateTermDates({ sequence: 1, startDate: "2026-06-01", endDate: "2026-08-15" }, session, [])).toMatch(/after its session/i);
  });

  it("rejects a duplicate sequence", () => {
    const siblings = [{ id: "t2", sessionId: "s1", name: "First", sequence: 1, startDate: "2025-09-01", endDate: "2025-12-12" }];
    expect(validateTermDates({ sequence: 1, startDate: "2026-01-05", endDate: "2026-04-10" }, session, siblings)).toMatch(/sequence 1/i);
  });

  it("rejects an overlap with a sibling term (sequence order must hold)", () => {
    const siblings = [{ id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: "2025-09-01", endDate: "2025-12-12" }];
    // Proposed second term starts inside the first term's window.
    expect(validateTermDates({ sequence: 2, startDate: "2025-12-01", endDate: "2026-03-01" }, session, siblings)).toMatch(/must end before/i);
  });

  it("rejects an OUT-OF-ORDER term even when it does not overlap (seq 2 dated before seq 1)", () => {
    // The gap the old overlap-only check missed: term 2 sits entirely BEFORE
    // term 1 with a clear gap — no overlap, but the order is wrong.
    const siblings = [{ id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: "2026-01-05", endDate: "2026-04-10" }];
    expect(validateTermDates({ sequence: 2, startDate: "2025-09-01", endDate: "2025-12-12" }, session, siblings)).toMatch(/must end before/i);
  });

  it("rejects a shared boundary day (would double-count that day in both terms)", () => {
    const siblings = [{ id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: "2025-09-01", endDate: "2025-12-12" }];
    // Second term starts the SAME day the first ends — inclusive windows overlap.
    expect(validateTermDates({ sequence: 2, startDate: "2025-12-12", endDate: "2026-03-01" }, session, siblings)).toMatch(/must end before/i);
  });

  it("allows adjacent terms with a one-day gap", () => {
    const siblings = [{ id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: "2025-09-01", endDate: "2025-12-12" }];
    expect(validateTermDates({ sequence: 2, startDate: "2025-12-13", endDate: "2026-03-01" }, session, siblings)).toBeNull();
  });

  it("does NOT cross-check when a needed date is absent (half-configured is allowed)", () => {
    const siblings = [{ id: "t1", sessionId: "s1", name: "First Term", sequence: 1, startDate: null, endDate: null }];
    expect(validateTermDates({ sequence: 2, startDate: "2025-12-01", endDate: "2026-03-01" }, session, siblings)).toBeNull();
  });

  it("validateSessionDates rejects end before start", () => {
    expect(validateSessionDates({ startDate: "2026-07-31", endDate: "2025-09-01" })).toMatch(/end date cannot be before/i);
    expect(validateSessionDates({ startDate: "2025-09-01", endDate: "2026-07-31" })).toBeNull();
  });
});

describe("standardTermDates", () => {
  const terms = standardTermDates("2025-09-08");

  it("produces three sequenced, named terms", () => {
    expect(terms).toHaveLength(3);
    expect(terms.map((t) => t.sequence)).toEqual([1, 2, 3]);
    expect(terms.map((t) => t.name)).toEqual(["First Term", "Second Term", "Third Term"]);
  });

  it("is chronological and non-overlapping (each term after the previous)", () => {
    for (let i = 1; i < terms.length; i += 1) {
      expect(new Date(terms[i].startDate).getTime()).toBeGreaterThan(new Date(terms[i - 1].endDate).getTime());
      expect(new Date(terms[i].endDate).getTime()).toBeGreaterThan(new Date(terms[i].startDate).getTime());
    }
  });

  it("starts term one on the chosen date, and every generated term passes its own validator", () => {
    expect(terms[0].startDate).toBe("2025-09-08");
    const session = { id: "s", startDate: terms[0].startDate, endDate: terms[2].endDate };
    const placed: Array<{ id: string; sessionId: string; name: string; sequence: number; startDate: string; endDate: string }> = [];
    for (const t of terms) {
      expect(validateTermDates(t, session, placed)).toBeNull();
      placed.push({ id: `t${t.sequence}`, sessionId: "s", ...t });
    }
  });
});

describe("teaching days", () => {
  const holidays = [{ startDate: "2025-10-01", endDate: "2025-10-03" }]; // Independence break

  it("isHoliday covers the inclusive span", () => {
    expect(isHoliday("2025-09-30", holidays)).toBe(false);
    expect(isHoliday("2025-10-01", holidays)).toBe(true);
    expect(isHoliday("2025-10-03", holidays)).toBe(true);
    expect(isHoliday("2025-10-04", holidays)).toBe(false);
  });

  it("isTeachingDay excludes weekends and holidays", () => {
    expect(isTeachingDay("2025-09-08", holidays)).toBe(true); // Monday
    expect(isTeachingDay("2025-09-13", holidays)).toBe(false); // Saturday
    expect(isTeachingDay("2025-09-14", holidays)).toBe(false); // Sunday
    expect(isTeachingDay("2025-10-02", holidays)).toBe(false); // holiday (a Thursday)
  });

  it("counts Saturday as a school day when the school opts in", () => {
    expect(isTeachingDay("2025-09-13", holidays, { saturdayIsSchoolDay: true })).toBe(true);
    expect(isTeachingDay("2025-09-14", holidays, { saturdayIsSchoolDay: true })).toBe(false); // Sunday still off
  });

  it("countTeachingDays sums a window minus weekends and holidays", () => {
    // Mon 8th – Fri 12th Sep 2025 = 5 weekdays, none on holiday.
    expect(countTeachingDays("2025-09-08", "2025-09-12", holidays)).toBe(5);
    // Include the weekend: still 5 (Sat/Sun excluded).
    expect(countTeachingDays("2025-09-08", "2025-09-14", holidays)).toBe(5);
    // A window over the Oct 1–3 holiday drops those weekdays.
    expect(countTeachingDays("2025-09-29", "2025-10-03", holidays)).toBe(2); // Mon 29, Tue 30 only
  });
});

// =============================================================================
// defaultSessionFor — the year a school being set up TODAY should start with
// =============================================================================
// Provisioning and the seed both create a calendar now, because a school without
// one has no current term, and three protections read that pointer and silently
// do not engage: the past-term register lock, roll-over, and the archive sweep.
//
// Creating one means guessing a year. The guess is wrong in a way nobody sees
// until a register is filed against a session that ended last summer.

describe("defaultSessionFor", () => {
  const at = (iso: string) => defaultSessionFor(new Date(`${iso}T12:00:00Z`));

  it("gives a school set up in September the year that is starting", () => {
    expect(at("2026-09-15")).toEqual({ name: "2026/2027", yearStart: "2026-09-01" });
  });

  it("gives a school set up in February the year it is ALREADY IN", () => {
    // The mid-year case. Rolling to 2027/2028 here would date every record a
    // full year forward.
    expect(at("2027-02-10")).toEqual({ name: "2026/2027", yearStart: "2026-09-01" });
  });

  it("gives a school set up in AUGUST the year ahead, not the one that ended", () => {
    // The reason the cutover is July and not September. Third Term ends in early
    // July, so an August school is preparing for the coming year — a September
    // cutover would hand it a session that had already finished.
    expect(at("2026-08-03")).toEqual({ name: "2026/2027", yearStart: "2026-09-01" });
  });

  it("treats 1 July as the first day of the year ahead", () => {
    expect(at("2026-07-01").name).toBe("2026/2027");
  });

  it("treats 30 June as still belonging to the year in progress", () => {
    // The exact boundary, checked from both sides — an off-by-one month here
    // dates a whole school's first year wrong.
    expect(at("2026-06-30").name).toBe("2025/2026");
  });

  it("names the session across the year boundary, never as a single year", () => {
    expect(at("2027-01-01").name).toBe("2026/2027");
    expect(at("2026-12-31").name).toBe("2026/2027");
  });

  it("always starts the session in September", () => {
    for (const d of ["2026-01-05", "2026-07-20", "2026-09-01", "2026-11-30"]) {
      expect(at(d).yearStart.slice(5)).toBe("09-01");
    }
  });

  it("produces a yearStart standardTermDates can consume, spanning ~11 months", () => {
    // The two are always used together; a yearStart the generator misreads would
    // produce terms in the wrong year with no error.
    const terms = standardTermDates(at("2026-08-03").yearStart);
    expect(terms).toHaveLength(3);
    expect(terms[0].startDate).toBe("2026-09-01");
    expect(terms[2].endDate.startsWith("2027-")).toBe(true);
  });
});

// =============================================================================
// pickOpeningTerm — which term a school being set up TODAY should open on
// =============================================================================
// "The term containing today" is right only while a term is running. Both
// provisioning and the seed originally fell back to the FIRST term whenever
// today sat outside every term — which for a school set up during the Christmas
// break handed it a First Term that had already ended, so its first registers
// would file into a closed term and the past-term lock would guard a shut
// window. The term about to BEGIN is the one they will actually teach in.

describe("pickOpeningTerm", () => {
  const T = standardTermDates("2026-09-01"); // Sep1–Nov29 / Dec21–Mar20 / Apr11–Jul9
  const on = (iso: string) => pickOpeningTerm(T, new Date(`${iso}T12:00:00Z`));

  it("picks the term that contains today", () => {
    expect(on("2026-10-20")).toBe(0);
    expect(on("2027-02-10")).toBe(1);
    expect(on("2027-05-20")).toBe(2);
  });

  it("picks the term ABOUT TO BEGIN when today falls in a break", () => {
    // 5 December: First Term ended 29 November, Second starts 21 December.
    // Taking First Term here is the bug this function exists to prevent.
    expect(on("2026-12-05")).toBe(1);
    expect(on("2027-03-28")).toBe(2); // between Second and Third
  });

  it("picks the first term when the whole session is still ahead", () => {
    expect(on("2026-08-03")).toBe(0);
  });

  it("picks the LAST term when the session is entirely behind us", () => {
    // Nothing ahead to point at. The calendar panel reports this as a year that
    // has ended rather than the code inventing a term.
    expect(on("2027-08-15")).toBe(2);
  });

  it("includes both boundary days of a term", () => {
    expect(on("2026-09-01")).toBe(0);
    expect(on("2026-11-29")).toBe(0);
    expect(on("2026-11-30")).toBe(1); // the day after it ends
  });

  it("returns -1 for a session with no terms rather than pretending index 0", () => {
    expect(pickOpeningTerm([], new Date())).toBe(-1);
  });
});

// =============================================================================
// The academic year does not open in September everywhere
// =============================================================================
// The platform assumed it did, which is six months wrong for the whole of
// southern Africa: a school in Johannesburg, Harare or Lusaka runs January to
// December. Provisioning one as September would file its first registers against
// a session that does not exist yet.

describe("defaultSessionFor across hemispheres", () => {
  const at = (iso: string, m: number) => defaultSessionFor(new Date(`${iso}T12:00:00Z`), m);

  it("leaves a September-start country exactly as it was", () => {
    // The regression that matters most: every school already live is Nigeria.
    expect(at("2026-08-04", 9)).toEqual({ name: "2026/2027", yearStart: "2026-09-01" });
    expect(at("2027-02-10", 9)).toEqual({ name: "2026/2027", yearStart: "2026-09-01" });
  });

  it("opens a southern-hemisphere year in JANUARY", () => {
    expect(at("2027-03-01", 1)).toEqual({ name: "2027", yearStart: "2027-01-01" });
  });

  it("names a January year with ONE year, not two", () => {
    // A year that opens and closes inside the same calendar year would be
    // misdescribed as "2027/2028" on every report card it heads.
    expect(at("2027-03-01", 1).name).toBe("2027");
    expect(at("2027-03-01", 9).name).toBe("2026/2027");
  });

  it("rolls a January-start school forward in NOVEMBER, wrapping the year", () => {
    // Two months before opening, which for a January start is November of the
    // PREVIOUS calendar year — the wraparound the arithmetic has to survive.
    expect(at("2026-10-31", 1).name).toBe("2026");
    expect(at("2026-11-01", 1).name).toBe("2027");
    expect(at("2026-12-20", 1).name).toBe("2027");
  });

  it("handles an April-start country", () => {
    expect(at("2026-08-04", 4)).toEqual({ name: "2026/2027", yearStart: "2026-04-01" });
  });

  it("takes the month from the COUNTRY, so adding one is a data change", () => {
    expect(countryProfile("ZA").academicYearStartMonth).toBe(1);
    expect(countryProfile("NG").academicYearStartMonth).toBe(9);
    expect(countryProfile("IN").academicYearStartMonth).toBe(4);
    // An unknown country falls back to the platform's home default.
    expect(countryProfile("XX").academicYearStartMonth).toBe(9);
  });

  it("gives every catalogued country a start month", () => {
    // A missing one would silently become undefined and produce an invalid date.
    for (const code of ["NG", "ZA", "GH", "KE", "ZW", "SG", "US", "GB", "IN", "CI"]) {
      const m = countryProfile(code).academicYearStartMonth;
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(12);
    }
  });
});
