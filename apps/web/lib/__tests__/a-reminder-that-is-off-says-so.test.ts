// =============================================================================
// A school nobody was chasing, on a board that looked fine
// =============================================================================
// The daily register reminder skips a school with no CURRENT TERM — correctly,
// because outside a term there is no register to take. But a school that has
// never set up its academic calendar is skipped every day, for ever, and the
// only trace was a `skipped` count in an operator console the school does not
// open. The board on /attendance went on showing the day's gaps exactly as it
// does for a school whose teachers are being reminded every afternoon.
//
// A control that is silently off is worse than one that is missing: the screen
// beside it keeps saying the day is under control.
//
// The board states it now, and the decision comes from `reminderOffReason` —
// the SAME function the sweep uses — so it cannot claim registers are being
// chased while the sweep quietly skips the school.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../test-support/strip-comments";

const WEB = join(__dirname, "../..");
const BOARD = stripComments(readFileSync(join(WEB, "components/attendance/RegisterBoard.tsx"), "utf8"));
const BUTTON = stripComments(readFileSync(join(WEB, "components/maintenance/SweepButton.tsx"), "utf8"));

describe("the board says when nobody is being reminded", () => {
  it("reads the reminder state the API returns", () => {
    expect(BOARD).toMatch(/remindersActive/);
    expect(BOARD).toMatch(/remindersOffReason/);
  });

  it("has wording for EVERY reason the API can return", () => {
    // A code with no sentence renders as blank — the same silence, one layer up.
    for (const reason of ["NO_CURRENT_TERM", "OUTSIDE_TERM", "HOLIDAY", "NON_SCHOOL_DAY"]) {
      expect(BOARD).toContain(reason);
    }
  });

  it("names the FIX for the one that is a real gap", () => {
    // "No reminders are being sent" is a fact; "set the current term on the
    // academic calendar" is the way out. A refusal that does not name one is
    // the shape this repo records against.
    expect(BOARD).toMatch(/NO_CURRENT_TERM[\s\S]{0,400}current term/i);
    expect(BOARD).toMatch(/NO_CURRENT_TERM[\s\S]{0,400}calendar/i);
  });

  it("shows the missing-calendar case LOUDLY, not as grey small print", () => {
    // A weekend needs a footnote. Never being chased at all needs to be seen.
    const block = BOARD.slice(BOARD.indexOf("remindersOffReason ==="));
    expect(block.slice(0, 400)).toMatch(/amber|destructive|border/);
  });

  it("says nothing at all when the reminder IS running", () => {
    // The line appears only when there is something to say; a banner that is
    // always there is a banner nobody reads.
    expect(BOARD).toMatch(/!status\.remindersActive/);
  });
});

describe("the button does not report a skipped run as a clean one", () => {
  it("distinguishes 'nothing to chase' from 'nothing was chased'", () => {
    // It said "Every register has been taken today" whenever nothing was
    // outstanding — INCLUDING when the sweep never looked, because the school
    // has no current term. Reporting a school that is never chased as a school
    // with nothing to chase is the silent-success shape.
    const entry = BUTTON.slice(BUTTON.indexOf('"attendance/register-reminder/run"'));
    expect(entry.slice(0, 900)).toMatch(/skipped\s*>\s*0/);
    expect(entry.slice(0, 900)).toMatch(/no current term/i);
  });

  it("still reports the honest all-clear when the sweep DID look", () => {
    const entry = BUTTON.slice(BUTTON.indexOf('"attendance/register-reminder/run"'));
    expect(entry.slice(0, 900)).toMatch(/Every register has been taken/);
  });

  it("names the registers nobody can be reminded about", () => {
    const entry = BUTTON.slice(BUTTON.indexOf('"attendance/register-reminder/run"'));
    expect(entry.slice(0, 1200)).toMatch(/unreachable/);
    expect(entry.slice(0, 1200)).toMatch(/no class teacher/i);
  });
});
