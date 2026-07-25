// =============================================================================
// Academic-calendar pure helpers — validation, standard-session, teaching days
// =============================================================================

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
