// =============================================================================
// Pure exam clash detection (@sms/types/exam-conflicts)
// =============================================================================
// The server refuses a clash and the planning grid previews one from this SAME
// code, so these tests are the contract between them. The back-to-back case is
// the one that matters most in practice: get it wrong and every consecutive pair
// of exams in a hall reports a false clash, which trains exam officers to ignore
// the warning entirely.
// =============================================================================

import {
  describeClash,
  findHallClash,
  findPersonClash,
  isValidTimeRange,
  minutesOfDay,
  sameHall,
  timeRangesOverlap,
  type ClashCandidate,
} from "@sms/types";

const sitting = (over: Partial<ClashCandidate> = {}): ClashCandidate => ({
  id: "s1",
  date: "2026-11-03",
  startsAt: "09:00",
  endsAt: "11:00",
  hall: "Hall A",
  title: "Mathematics SS1",
  ...over,
});

describe("minutesOfDay", () => {
  it("parses 24h labels", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("09:30")).toBe(570);
    expect(minutesOfDay("23:59")).toBe(1439);
    expect(minutesOfDay("9:05")).toBe(545); // single-digit hour
  });

  it("returns -1 for anything unparseable rather than NaN", () => {
    // NaN would silently make every comparison false, i.e. silently disable the
    // clash check. -1 is at least a value the callers can test for.
    for (const bad of ["", "  ", "9", "09-30", "24:00", "09:60", "abc", "09:0"]) {
      expect(minutesOfDay(bad)).toBe(-1);
    }
  });
});

describe("isValidTimeRange", () => {
  it("requires a positive duration", () => {
    expect(isValidTimeRange("09:00", "11:00")).toBe(true);
    expect(isValidTimeRange("09:00", "09:00")).toBe(false); // zero-length exam
    expect(isValidTimeRange("11:00", "09:00")).toBe(false); // ends before it starts
    expect(isValidTimeRange("09:00", "bad")).toBe(false);
  });
});

describe("timeRangesOverlap", () => {
  it("treats ranges as HALF-OPEN so back-to-back exams do NOT clash", () => {
    // 09:00-11:00 then 11:00-13:00 in the same hall is the normal school day.
    expect(timeRangesOverlap("09:00", "11:00", "11:00", "13:00")).toBe(false);
    expect(timeRangesOverlap("11:00", "13:00", "09:00", "11:00")).toBe(false);
  });

  it("detects every real overlap shape", () => {
    expect(timeRangesOverlap("09:00", "11:00", "10:00", "12:00")).toBe(true); // partial, later
    expect(timeRangesOverlap("10:00", "12:00", "09:00", "11:00")).toBe(true); // partial, earlier
    expect(timeRangesOverlap("09:00", "11:00", "09:30", "10:00")).toBe(true); // contained
    expect(timeRangesOverlap("09:30", "10:00", "09:00", "11:00")).toBe(true); // containing
    expect(timeRangesOverlap("09:00", "11:00", "09:00", "11:00")).toBe(true); // identical
    expect(timeRangesOverlap("09:00", "11:00", "10:59", "11:30")).toBe(true); // one minute
  });

  it("does not overlap when genuinely apart", () => {
    expect(timeRangesOverlap("09:00", "11:00", "13:00", "15:00")).toBe(false);
  });

  it("declines to judge unparseable times instead of guessing", () => {
    // Returning true here would block a save over a typo the user cannot see;
    // returning false lets the range validator produce the specific error.
    expect(timeRangesOverlap("09:00", "11:00", "bad", "11:30")).toBe(false);
  });
});

describe("sameHall", () => {
  it("ignores case and surrounding whitespace", () => {
    // This is what stopped "Hall A" / "hall A" / " Hall A " being three halls.
    expect(sameHall("Hall A", "hall a")).toBe(true);
    expect(sameHall("  Hall A  ", "Hall A")).toBe(true);
    expect(sameHall("Hall A", "Hall B")).toBe(false);
  });
});

describe("findHallClash", () => {
  it("finds a same-hall overlap and returns the offender so it can be named", () => {
    const clash = findHallClash(
      { date: "2026-11-03", startsAt: "10:00", endsAt: "12:00", hall: "hall a" },
      [sitting()],
    );
    expect(clash?.title).toBe("Mathematics SS1");
    expect(describeClash("hall", clash!)).toBe(
      'Hall A is already taken by "Mathematics SS1" (09:00–11:00) that day',
    );
  });

  it("ignores a different hall, a different day, and a back-to-back slot", () => {
    const base = { date: "2026-11-03", startsAt: "09:00", endsAt: "11:00" };
    expect(findHallClash({ ...base, hall: "Hall B" }, [sitting()])).toBeNull();
    expect(findHallClash({ ...base, date: "2026-11-04", hall: "Hall A" }, [sitting()])).toBeNull();
    expect(
      findHallClash({ date: "2026-11-03", startsAt: "11:00", endsAt: "13:00", hall: "Hall A" }, [sitting()]),
    ).toBeNull();
  });

  it("returns null against an empty set", () => {
    expect(findHallClash({ date: "2026-11-03", startsAt: "09:00", endsAt: "11:00", hall: "Hall A" }, [])).toBeNull();
  });
});

describe("findPersonClash", () => {
  it("clashes across DIFFERENT halls — the case a hall-only check misses", () => {
    const clash = findPersonClash({ date: "2026-11-03", startsAt: "10:00", endsAt: "12:00" }, [
      sitting({ hall: "Hall B", title: "English SS2" }),
    ]);
    expect(clash?.title).toBe("English SS2");
    expect(describeClash("invigilator", clash!)).toBe(
      'Already invigilating "English SS2" (09:00–11:00) that day',
    );
  });

  it("allows consecutive duties in the same hall", () => {
    expect(findPersonClash({ date: "2026-11-03", startsAt: "11:00", endsAt: "13:00" }, [sitting()])).toBeNull();
  });

  it("ignores another day entirely", () => {
    expect(findPersonClash({ date: "2026-11-10", startsAt: "09:00", endsAt: "11:00" }, [sitting()])).toBeNull();
  });
});
