/**
 * The group console's pure rules: which days a campus is measured over, which
 * days it is compared with, and when a campus is flagged.
 *
 * The SQL that counts within those windows is driven against Postgres in
 * campus-figures.e2e-spec; these are the decisions made before any query runs.
 */
import { campusWindow, flagsFor, previousWindow, type Campus, type FlagInputs } from "../../src/group/campus-metrics";

const lagos = (over: Partial<Campus> = {}): Campus => ({
  id: "a",
  timezone: "Africa/Lagos",
  schoolDays: [1, 2, 3, 4, 5],
  currentTerm: { startDate: "2026-09-08", endDate: "2026-12-11" },
  datedTerms: [{ from: "2026-09-08", to: "2026-12-11" }],
  ...over,
});

// 10:00 in Lagos on Thursday 15 October 2026.
const NOW = new Date("2026-10-15T09:00:00.000Z");

describe("the window a campus is measured over", () => {
  it("'This term' is the campus's OWN current term, up to today", () => {
    const w = campusWindow("term", lagos(), NOW);
    expect(w).toMatchObject({ fromDay: "2026-09-08", toDay: "2026-10-15", basis: "TERM" });
    // From midnight IN LAGOS on the first day of term.
    expect(w.fromInstant.toISOString()).toBe("2026-09-07T23:00:00.000Z");
    expect(w.toInstant).toBe(NOW);
  });

  it("stops at the term's last day once the term is over", () => {
    const w = campusWindow("term", lagos({ currentTerm: { startDate: "2026-04-20", endDate: "2026-07-24" } }), NOW);
    expect(w).toMatchObject({ fromDay: "2026-04-20", toDay: "2026-07-24", basis: "TERM" });
    // To midnight AFTER the last day, not to now — nothing after term counts.
    expect(w.toInstant.toISOString()).toBe("2026-07-24T23:00:00.000Z");
  });

  it("falls back to the last 90 days, and SAYS so, with no current term", () => {
    const w = campusWindow("term", lagos({ currentTerm: null }), NOW);
    expect(w).toMatchObject({ fromDay: "2026-07-18", toDay: "2026-10-15", basis: "NO_TERM_LAST_90_DAYS" });
  });

  it("does not borrow another campus's dates: two campuses, two terms", () => {
    const a = campusWindow("term", lagos(), NOW);
    const b = campusWindow("term", lagos({ id: "b", currentTerm: { startDate: "2026-09-21", endDate: null } }), NOW);
    expect(a.fromDay).toBe("2026-09-08");
    expect(b.fromDay).toBe("2026-09-21");
  });
});

describe("the window a campus is compared with", () => {
  it("compares month-to-date with the SAME days of last month, never the whole of it", () => {
    const cur = campusWindow("month", lagos(), NOW);
    const prev = previousWindow("month", cur, lagos());
    expect(prev).toMatchObject({ fromDay: "2026-09-01", toDay: "2026-09-15" });
    // To the same point of the day, so a morning is not compared with a whole day.
    expect(prev.toInstant.getTime() - prev.fromInstant.getTime()).toBe(cur.toInstant.getTime() - cur.fromInstant.getTime());
  });

  it("compares a week with the seven days before it, with no overlap", () => {
    const cur = campusWindow("week", lagos(), NOW);
    const prev = previousWindow("week", cur, lagos());
    expect(cur).toMatchObject({ fromDay: "2026-10-09", toDay: "2026-10-15" });
    expect(prev).toMatchObject({ fromDay: "2026-10-02", toDay: "2026-10-08" });
    expect(prev.toInstant.getTime()).toBeLessThanOrEqual(cur.fromInstant.getTime());
  });

  it("never overlaps on the 31st, when last month was shorter", () => {
    const at = new Date("2026-10-31T09:00:00.000Z");
    const cur = campusWindow("month", lagos(), at);
    const prev = previousWindow("month", cur, lagos());
    expect(prev.fromDay).toBe("2026-09-01");
    expect(prev.toDay).toBe("2026-09-30");
    expect(prev.toInstant.getTime()).toBeLessThanOrEqual(cur.fromInstant.getTime());
  });
});

describe("when a campus is flagged", () => {
  const healthy: FlagInputs = {
    active: true,
    subscriptionStatus: "ACTIVE",
    students: 300,
    staff: 25,
    registersTaken: 40,
    registersExpected: 40,
    registersCovered: 40,
    registerCoveragePct: 100,
    hasCurrentTerm: true,
    attendancePct: 93,
  };

  it("raises nothing for a healthy campus", () => {
    expect(flagsFor(healthy)).toEqual([]);
  });

  it("does NOT say 'no registers' on a day none were due — a weekend, a holiday", () => {
    // It used to: "today" on a Saturday flagged every campus in the group.
    expect(
      flagsFor({ ...healthy, registersTaken: 0, registersExpected: 0, registersCovered: 0, registerCoveragePct: null, attendancePct: null }),
    ).toEqual([]);
  });

  it("says 'no registers' when registers were due and none were taken", () => {
    expect(flagsFor({ ...healthy, registersTaken: 0, registersCovered: 0, registerCoveragePct: 0, attendancePct: null })).toEqual([
      "NO_REGISTERS",
    ]);
  });

  it("flags registers MISSED, not merely taken — 30 of 40 is not fine", () => {
    expect(flagsFor({ ...healthy, registersCovered: 30, registerCoveragePct: 75 })).toEqual(["LOW_REGISTER_COVERAGE"]);
  });

  it("flags a campus with pupils and no current term — its reminder never runs", () => {
    expect(flagsFor({ ...healthy, hasCurrentTerm: false })).toContain("NO_TERM");
  });

  it("falls back to the coarse test when no dated term says which days were due", () => {
    expect(
      flagsFor({ ...healthy, registersTaken: 0, registersExpected: null, registersCovered: null, registerCoveragePct: null, attendancePct: null }),
    ).toEqual(["NO_REGISTERS"]);
  });

  it("flags low attendance independently of register coverage", () => {
    expect(flagsFor({ ...healthy, registerCoveragePct: 70, attendancePct: 70 })).toEqual(["LOW_REGISTER_COVERAGE", "LOW_ATTENDANCE"]);
  });
});
