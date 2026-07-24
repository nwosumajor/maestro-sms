import { expandOccurrences, MAX_OCCURRENCES } from "@sms/types";

const d = (iso: string) => new Date(iso);
const WIN_START = d("2026-09-01T00:00:00.000Z");
const WIN_END = d("2026-09-30T23:59:59.000Z");

describe("expandOccurrences", () => {
  it("a non-recurring event yields itself when it overlaps the window", () => {
    const out = expandOccurrences({ startsAt: d("2026-09-10T09:00:00.000Z"), endsAt: d("2026-09-10T10:00:00.000Z") }, WIN_START, WIN_END);
    expect(out).toHaveLength(1);
    expect(out[0].startsAt.toISOString()).toBe("2026-09-10T09:00:00.000Z");
    expect(out[0].endsAt?.toISOString()).toBe("2026-09-10T10:00:00.000Z");
  });

  it("a non-recurring event outside the window yields nothing", () => {
    const out = expandOccurrences({ startsAt: d("2026-08-10T09:00:00.000Z"), endsAt: d("2026-08-10T10:00:00.000Z") }, WIN_START, WIN_END);
    expect(out).toEqual([]);
  });

  it("WEEKLY on a single weekday repeats through the window", () => {
    // 2026-09-07 is a Monday.
    const out = expandOccurrences(
      { startsAt: d("2026-09-07T07:30:00.000Z"), endsAt: d("2026-09-07T08:00:00.000Z"), recurrence: "WEEKLY", recurrenceDays: ["MON"] },
      WIN_START,
      WIN_END,
    );
    expect(out.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    // Duration is carried onto every occurrence.
    expect(out[1].endsAt?.toISOString()).toBe("2026-09-14T08:00:00.000Z");
  });

  it("WEEKLY on several weekdays yields each of them", () => {
    const out = expandOccurrences(
      { startsAt: d("2026-09-07T07:30:00.000Z"), recurrence: "WEEKLY", recurrenceDays: ["MON", "WED"] },
      WIN_START,
      d("2026-09-16T23:59:59.000Z"),
    );
    expect(out.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual(["2026-09-07", "2026-09-09", "2026-09-14", "2026-09-16"]);
  });

  it("WEEKLY with no explicit days repeats on the start date's own weekday", () => {
    const out = expandOccurrences({ startsAt: d("2026-09-04T10:00:00.000Z"), recurrence: "WEEKLY" }, WIN_START, WIN_END); // a Friday
    expect(out.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual(["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25"]);
  });

  it("recurrenceUntil ends the series early", () => {
    const out = expandOccurrences(
      { startsAt: d("2026-09-07T07:30:00.000Z"), recurrence: "WEEKLY", recurrenceDays: ["MON"], recurrenceUntil: d("2026-09-15T00:00:00.000Z") },
      WIN_START,
      WIN_END,
    );
    expect(out.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual(["2026-09-07", "2026-09-14"]);
  });

  it("DAILY fills the window and MONTHLY steps a month at a time", () => {
    const daily = expandOccurrences({ startsAt: d("2026-09-01T06:00:00.000Z"), recurrence: "DAILY" }, WIN_START, WIN_END);
    expect(daily).toHaveLength(30);
    const monthly = expandOccurrences(
      { startsAt: d("2026-01-31T06:00:00.000Z"), recurrence: "MONTHLY" },
      d("2026-01-01T00:00:00.000Z"),
      d("2026-04-30T23:59:59.000Z"),
    );
    // Jan 31 -> Feb 28 (clamped, no rollover into March) -> Mar 31 -> Apr 30.
    expect(monthly.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("an endless series is bounded by the window, and hard-capped", () => {
    const out = expandOccurrences(
      { startsAt: d("2026-01-01T06:00:00.000Z"), recurrence: "DAILY" }, // no `until`
      d("2026-01-01T00:00:00.000Z"),
      d("2030-01-01T00:00:00.000Z"), // absurd window
    );
    expect(out.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
  });

  it("a series that ended before the window yields nothing", () => {
    const out = expandOccurrences(
      { startsAt: d("2026-01-05T09:00:00.000Z"), recurrence: "WEEKLY", recurrenceDays: ["MON"], recurrenceUntil: d("2026-02-01T00:00:00.000Z") },
      WIN_START,
      WIN_END,
    );
    expect(out).toEqual([]);
  });
});
