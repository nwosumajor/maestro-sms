// =============================================================================
// Calendar health — does it name the RIGHT consequence?
// =============================================================================
// The value of this check is not that it spots a missing date. It is that it
// says what the missing date has switched off, and those claims have to be true
// of the actual code:
//
//   • no startDate on the CURRENT term  → markAttendance's `lockBefore` is null,
//     so `if (lockBefore && …)` never fires and past-term registers are editable
//   • no endDate                        → termHasElapsed returns false, so
//     roll-over never runs; and the archive sweep selects endDate IS NOT NULL,
//     so the term is never archived
//
// A finding that overstates its consequence is worse than none: the first time
// someone checks and finds the claim false, they stop believing the whole panel.
// =============================================================================

import { assessCalendar, calendarIsSound, termHasElapsed, type CalendarSessionInput } from "@sms/types";

const term = (over: Partial<CalendarSessionInput["terms"][number]> = {}) => ({
  id: "t-1",
  name: "First Term",
  sequence: 1,
  isCurrent: true,
  startDate: "2026-09-01",
  endDate: "2026-12-15",
  ...over,
});

const session = (over: Partial<CalendarSessionInput> = {}): CalendarSessionInput => ({
  id: "s-1",
  name: "2026/2027",
  isCurrent: true,
  startDate: "2026-09-01",
  endDate: "2027-07-31",
  terms: [term()],
  ...over,
});

const titles = (f: ReturnType<typeof assessCalendar>) => f.map((x) => x.title).join(" | ");

describe("a sound calendar", () => {
  it("reports nothing", () => {
    expect(assessCalendar([session()])).toEqual([]);
    expect(calendarIsSound(assessCalendar([session()]))).toBe(true);
  });
});

describe("the consequences it claims are the ones the code actually has", () => {
  it("names the REGISTER LOCK when the current term has no start date", () => {
    // markAttendance: `const lockBefore = await this.currentTermStart(...)` then
    // `if (lockBefore && date < lockBefore) throw`. Null lockBefore = no lock.
    const f = assessCalendar([session({ terms: [term({ startDate: null })] })]);
    const hit = f.find((x) => x.title.includes("no start date"));
    expect(hit?.severity).toBe("critical");
    expect(hit?.consequence).toMatch(/register lock is OFF/i);
  });

  it("names ROLL-OVER and ARCHIVING when the current term has no end date", () => {
    const f = assessCalendar([session({ terms: [term({ endDate: null })] })]);
    const hit = f.find((x) => x.title.includes("no end date"));
    expect(hit?.consequence).toMatch(/never roll/i);
    expect(hit?.consequence).toMatch(/never be archived/i);
  });

  it("and termHasElapsed really does return false without an end date", () => {
    // The claim above, checked against the function it describes rather than
    // asserted in prose. If this ever changes, the finding becomes a lie.
    expect(termHasElapsed(null, new Date("2030-01-01"))).toBe(false);
    expect(termHasElapsed("2026-12-15", new Date("2030-01-01"))).toBe(true);
  });
});

describe("states that make 'now' ambiguous", () => {
  it("flags no current term — the lock has nothing to read", () => {
    const f = assessCalendar([session({ terms: [term({ isCurrent: false })] })]);
    expect(titles(f)).toMatch(/No term is marked as the current one/);
    expect(calendarIsSound(f)).toBe(false);
  });

  it("flags TWO current terms, which is worse than none", () => {
    // None is at least detectable at the point of use. Two is silently arbitrary.
    const f = assessCalendar([
      session({ terms: [term(), term({ id: "t-2", name: "Second Term", sequence: 2, startDate: "2027-01-05", endDate: "2027-04-01" })] }),
    ]);
    expect(titles(f)).toMatch(/2 terms are marked current/);
  });

  it("flags two current SESSIONS", () => {
    const f = assessCalendar([session(), session({ id: "s-2", name: "2027/2028" })]);
    expect(titles(f)).toMatch(/sessions are marked current/);
  });

  it("flags a session with no terms at all", () => {
    const f = assessCalendar([session({ terms: [] })]);
    expect(titles(f)).toMatch(/no terms/);
  });

  it("flags having no session whatsoever, and stops there", () => {
    // No point listing term problems for a school that has not started setup.
    const f = assessCalendar([]);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("critical");
  });
});

describe("gaps between terms", () => {
  const two = (firstEnd: string, secondStart: string) =>
    assessCalendar([
      session({
        terms: [
          term({ endDate: firstEnd }),
          term({ id: "t-2", name: "Second Term", sequence: 2, isCurrent: false, startDate: secondStart, endDate: "2027-04-01" }),
        ],
      }),
    ]);

  it("says nothing about a one-day boundary — that is the required gap", () => {
    // The term validator REQUIRES terms not to share a day, because report-card
    // windows are inclusive. A single clear day is correct, not a finding.
    expect(two("2026-12-15", "2026-12-16").filter((f) => f.title.includes("fall between"))).toEqual([]);
  });

  it("says nothing about a long holiday", () => {
    expect(two("2026-12-15", "2027-01-10").filter((f) => f.title.includes("fall between"))).toEqual([]);
  });

  it("flags the few-day gap that is probably a typo", () => {
    const f = two("2026-12-15", "2026-12-22").find((x) => x.title.includes("fall between"));
    expect(f?.severity).toBe("info");
    expect(f?.consequence).toMatch(/counted in no report card/i);
  });
});

describe("ordering", () => {
  it("puts the critical finding first", () => {
    // A list that opens with a cosmetic gap while the register lock is off reads
    // as cosmetic, and gets closed.
    const f = assessCalendar([
      session({
        terms: [
          term({ startDate: null }),
          term({ id: "t-2", name: "Second Term", sequence: 2, isCurrent: false, startDate: "2026-12-22", endDate: "2027-04-01" }),
        ],
      }),
    ]);
    expect(f[0].severity).toBe("critical");
  });
});
