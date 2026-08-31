/**
 * A CALENDAR THAT COULD ONLY HOLD AN INSTANT.
 *
 * `EventForm`'s own placeholder read "e.g. Mid-term break" — a multi-day,
 * all-day event it could not create. `endsAt`, `allDay`, `recurrence`,
 * `recurrenceDays` and `recurrenceUntil` have been on the schema since the
 * module shipped, and the form sent NONE of them: every entry was a single
 * point in time, so a school could not put a holiday or a weekly assembly on
 * its own calendar. The recurrence engine — DAILY / WEEKLY / MONTHLY, per
 * weekday, with an end date, unit-tested — was reachable from nothing.
 *
 * AND THE READER WAS WRONG TOO, which only building the form could show.
 * `GET /events` expands a series into one row per occurrence, each carrying the
 * whole series with `occurrenceStartsAt` saying WHICH occurrence it is. The DTO
 * exposed only `startsAt`, so the calendar page rendered every Monday assembly
 * on the FIRST Monday — a term of them stacked on one date, with the same React
 * key on all of them.
 *
 * Verified on the RENDERED page, not the API: assembly on 7, 14, 21, 28 Sept …
 * 14 Dec, each on its own date; the break as "26 Oct 2026 — 31 Oct 2026" with
 * no time at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "..", "web");
const FORM = readFileSync(join(WEB, "components", "calendar", "EventForm.tsx"), "utf8");
const PAGE = readFileSync(join(WEB, "app", "(app)", "calendar", "page.tsx"), "utf8");
const DTO = readFileSync(
  join(__dirname, "..", "..", "..", "..", "packages", "types", "src", "dto", "calendar.ts"),
  "utf8",
);

describe("the form can describe a real school event", () => {
  it("sends an end, so an event can last more than a moment", () => {
    expect(FORM).toMatch(/endsAt: allDay \?/);
  });

  it("SENDS allDay — not merely uses it to shape the dates", () => {
    // Removing the field from the payload left every date-construction
    // assertion passing, because those read `allDay ? … : …`. The server would
    // then store a midnight-to-midnight event that is not marked all-day, and
    // the calendar would print a time on a holiday.
    const body = FORM.slice(FORM.indexOf("body: JSON.stringify({"), FORM.indexOf("provider: provider || undefined"));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toMatch(/^\s*allDay,$/m);
  });

  it("sends allDay, and dates an all-day event from midnight to end of day", () => {
    // A `datetime-local` cannot express a whole day, so the inputs become plain
    // dates and the times are supplied — otherwise "Mid-term break" would begin
    // at whatever o'clock somebody happened to pick.
    expect(FORM).toMatch(/allDay \? new Date\(`\$\{startsAt\}T00:00:00`\)/);
    expect(FORM).toMatch(/T23:59:59`\)/);
  });

  it("sends recurrence only when there is one", () => {
    // Sending NONE plus an empty day list is a payload a reader has to explain.
    expect(FORM).toMatch(/recurrence !== "NONE"/);
  });

  it("sends the weekday list ONLY for a weekly rule", () => {
    // The engine ignores it otherwise, and a value that is ignored is one
    // somebody later assumes is honoured.
    expect(FORM).toMatch(/recurrence === "WEEKLY" && recurrenceDays\.length > 0/);
  });

  it("says what a blank end date means, rather than leaving it to be found out", () => {
    expect(FORM).toMatch(/repeats indefinitely/);
  });

  it("clears the date inputs when the all-day toggle flips", () => {
    // The two inputs take different VALUE formats; a stale value from the other
    // mode is not a date the browser will accept.
    const toggle = FORM.slice(FORM.indexOf("checked={allDay}"), FORM.indexOf("All day"));
    expect(toggle).toContain('setStartsAt("")');
    expect(toggle).toContain('setEndsAt("")');
  });
});

describe("the calendar renders the occurrence, not the series", () => {
  it("the DTO carries which occurrence a row is", () => {
    expect(DTO).toMatch(/occurrenceStartsAt: Date;/);
    expect(DTO).toMatch(/occurrenceEndsAt: Date \| null;/);
    expect(DTO).toMatch(/allDay: boolean;/);
  });

  it("the page reads it, falling back for a one-off", () => {
    expect(PAGE).toMatch(/e\.occurrenceStartsAt \?\? e\.startsAt/);
  });

  it("gives every occurrence its own key", () => {
    // `e${e.id}` was the same for every occurrence of one series.
    expect(PAGE).toMatch(/key: `e\$\{e\.id\}:\$\{at\.getTime\(\)\}`/);
  });

  it("shows an all-day event as a date, never a time", () => {
    // "Mid-term break, 00:00" reads as a mistake.
    expect(PAGE).toMatch(/e\.allDay/);
    expect(PAGE).toMatch(/shortDate\(at\.toISOString\(\), region\)/);
  });

  it("names both ends of a multi-day event", () => {
    expect(PAGE).toMatch(/occurrenceEndsAt &&[\s\S]{0,120}toDateString\(\) !== at\.toDateString\(\)/);
  });
});
