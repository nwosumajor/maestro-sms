// =============================================================================
// A read that FAILED is not a read that came back empty
// =============================================================================
// The pattern was `setRows(res.ok ? await res.json() : [])`. It is one line and
// it looks defensive. What it does is take a request that failed and render it
// as a fact:
//
//   MyMarks            -> "Nothing has been marked yet this term."
//                         Said to a pupil or their parent about that pupil's own
//                         academic record, on the strength of a request that
//                         never returned. There is nothing on screen to tell it
//                         apart from the truth, and no reason to reload.
//
//   ProfileReviewQueue -> the card hides entirely, which to the member of staff
//                         who reviews profiles reads as "nothing is waiting for
//                         you" — the one thing a queue must not say when it does
//                         not know.
//
// The same distinction the server side already makes: `apiGet` returns null for
// "could not ask", never `[]`.
//
// These assertions are on source, because the defect is a shape rather than a
// behaviour: any component that collapses the two states has it, and the point
// is to stop the shape coming back.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

const WEB = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

describe("the two components that collapsed the states", () => {
  it("MyMarks distinguishes a failure from an empty term", () => {
    const src = read("components/gradebook/MyMarks.tsx");
    expect(src).not.toMatch(/r\.ok \? \(\(await r\.json\(\)\) as Mark\[\]\) : \[\]/);
    expect(src).toMatch(/setFailed\(true\)/);
    // And says so in words that stop the reader believing the empty state.
    expect(src).toMatch(/does not\s*\n?\s*mean nothing has been marked|does not mean nothing has been marked/);
    // The genuine empty state survives — it is the normal one early in a term.
    expect(src).toMatch(/Nothing has been marked yet this term/);
  });

  it("ProfileReviewQueue does not hide itself when it simply could not ask", () => {
    const src = read("components/sis/ProfileReviewQueue.tsx");
    expect(src).not.toMatch(/setRows\(res\.ok \? .* : \[\]\)/);
    expect(src).toMatch(/setFailed\(true\)/);
    expect(src).toMatch(/does not mean it is\s*\n?\s*empty|does not mean it is empty/);
  });

  it("a network throw counts as a failure, not as empty", () => {
    // `fetch` rejects on a dropped connection; an uncaught rejection inside the
    // effect leaves the component on its initial state forever.
    expect(read("components/gradebook/MyMarks.tsx")).toMatch(/catch \{/);
  });
});

describe("the shape, wherever it appears next", () => {
  /** Every .tsx under components/, recursively. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(join(WEB, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(join(WEB, rel)).isDirectory()) walk(rel, out);
      else if (e.endsWith(".tsx")) out.push(rel);
    }
    return out;
  }

  /**
   * Sites that still collapse the two states, each looked at and left for now.
   * They are NOT a clean bill of health — they are a backlog with reasons, kept
   * here so that the list is visible and so a NEW file cannot join it silently.
   *
   * Most are PICKERS and SEARCHES: the user is actively typing, an empty result
   * is on screen next to the thing they just typed, and retrying costs a
   * keystroke. An empty list there is misleading for a moment; an empty MARK
   * LIST or REGISTER BOARD is misleading indefinitely and is acted on. That is
   * the line the four fixed components fall on the wrong side of.
   *
   * The four with a real reading: RollCallPanel (a warden marking boarders sees
   * none), ExamPlanner (seats and invigilators read as unassigned),
   * TimetableViews (a teacher reads as having no lessons) and MessageCredits
   * (a ledger reads as having no entries). They are next.
   */
  const REVIEWED_AND_LEFT = [
    "components/attendance/StudentPicker.tsx", // picker
    "components/billing/MessageCreditsCard.tsx", // ledger drill-down — next
    "components/common/InlineSearch.tsx", // search
    "components/directory/DirectorySearch.tsx", // search
    "components/exam/ExamPlanner.tsx", // seats + invigilators — next
    "components/gradebook/GradingConsole.tsx", // class-subject picker
    "components/hostel/HostelOps.tsx", // roll-call panel — next
    "components/meeting/PeoplePicker.tsx", // picker
    "components/people/StudentPicker.tsx", // picker
    "components/people/UserPicker.tsx", // picker
    "components/timetable/TimetableAdmin.tsx", // roster + offering pickers
    "components/timetable/TimetableViews.tsx", // teacher/room grid — next
    "components/workflow/WorkflowInbox.tsx", // approver-options picker
  ];

  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    // THE FAILURE EVERY SOURCE-SCANNING GATE SHARES. The check above asserts an
    // EMPTY offender list, so a walk that returns no files passes with a green
    // tick while covering nothing at all — a moved directory, a changed
    // extension, a renamed root. Demonstrated on this repo by pointing one
    // gate's walk at a directory holding no `.ts` files: every assertion still
    // passed. The magnitude is the only thing that can tell "clean" from "blind".
    expect(walk("components").length).toBeGreaterThan(50);
  });

  it("no NEW component turns a non-ok response straight into an empty array", () => {
    // The exact expression that caused all four defects: a ternary on `ok` whose
    // failure branch is `[]`. It reads as a safe default and is an assertion.
    const offenders = walk("components").filter((f) => {
      if (REVIEWED_AND_LEFT.includes(f)) return false;
      const src = readFileSync(join(WEB, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      return /\.ok\s*\?[\s\S]{0,120}?:\s*\[\]/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the backlog only ever shrinks", () => {
    // A file that has been fixed must leave the list, or the list stops meaning
    // anything and the next reader trusts it.
    const stale = REVIEWED_AND_LEFT.filter((f) => {
      const src = readFileSync(join(WEB, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      return !/\.ok\s*\?[\s\S]{0,120}?:\s*\[\]/.test(src);
    });
    expect(stale).toEqual([]);
  });
});

// =============================================================================
// The same shape, in the date the screen prefills
// =============================================================================
// `new Date().toISOString().slice(0, 10)` is the UTC day on the USER's clock.
// The API decides the term lock, the 7-day stale rule and every register's
// filing date with `schoolToday(tz)`, so a page prefilled from UTC disagrees
// with the server about what day it is — and nobody looks, because the field is
// filled in and looks right.
//
// TakeRegister had already been fixed and carried the explanation in a comment.
// Eight other screens still did it, including two where the value is also the
// input's `max`: east of UTC that capped the date at YESTERDAY in the early
// morning, so a warden could not record today at all.
// =============================================================================

describe("today, on every screen that prefills it", () => {
  /** A filename stamp is not a school day — a downloaded file dated in UTC is
   *  nobody's business. Anything that drives a QUERY or an input is. */
  const NOT_A_SCHOOL_DAY = ["components/operator/StudentDataExport.tsx"];

  function walkAll(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(join(WEB, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(join(WEB, rel)).isDirectory()) walkAll(rel, out);
      else if (e.endsWith(".tsx")) out.push(rel);
    }
    return out;
  }

  it("comes from the school's timezone, not the browser's UTC day", () => {
    const files = [...walkAll("components"), ...walkAll("app")];
    const offenders = files.filter((f) => {
      if (NOT_A_SCHOOL_DAY.includes(f)) return false;
      const src = readFileSync(join(WEB, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      return /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("has one helper, so the rule is stated once", () => {
    expect(read("lib/format.ts")).toMatch(/export function todayIn\(timezone: string\): string/);
  });
});
