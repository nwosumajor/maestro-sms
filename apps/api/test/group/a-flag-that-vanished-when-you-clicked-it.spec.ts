// =============================================================================
// A campus flagged on the group overview showed NO flags on its own page
// =============================================================================
// The overview computes each campus's flags over the DIRECTOR'S SELECTED PERIOD.
// The drill-down computed them from `trend.at(-1)` — the CURRENT CALENDAR MONTH
// — and from a six-month count of attendance RECORDS where the overview counts
// SESSIONS. Two different questions wearing one name.
//
// Measured on a campus at 63% over ninety days:
//
//   overview  period=term   att 63 · regs 20 · flags LOW_ATTENDANCE
//   drill-down (no period)  att —  · regs —  · flags (none)
//
// The flag vanished exactly where a director goes to find out why.
//
// WORSE THAN A MISMATCH, and why this is not an edge case: the current calendar
// month is EMPTY on the 1st, so `attendancePct` was null and LOW_ATTENDANCE
// could not fire on any campus page for the first days of every month. A
// partial period read as a fact.
//
// // GOTCHA, and the reason this file was rewritten: the FIRST fix made the API
// take a `period` and this spec checked the API's SPELLING of it — and passed
// for as long as it existed while the WEB never sent one. The overview linked
// to `/group/<id>` bare, and the campus page called `/group/schools/<id>` with
// no query, so the server's half was inert. The figures themselves are now
// held to agreement BEHAVIOURALLY (group.service.spec — "the campus page
// reports the row it was clicked from", one `campusFigures` for both); what is
// left to check here is the half no API test can see: that the period is
// actually carried from the list, through the link, to the request.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const WEB = join(__dirname, "../../../web");
const board = stripComments(readFileSync(join(WEB, "components/group/GroupBoard.tsx"), "utf8"));
const campusPage = stripComments(readFileSync(join(WEB, "app/(app)/group/[schoolId]/page.tsx"), "utf8"));

describe("the period travels from the list to the campus page", () => {
  it("found the sources it is about", () => {
    expect(board.length).toBeGreaterThan(2000);
    expect(campusPage.length).toBeGreaterThan(2000);
  });

  it("links every campus WITH the list's period, never bare", () => {
    // Every link into a campus page. A bare `/group/${…}` with no query is the
    // defect; anchored to the PROPERTY (a query follows the id), not to the
    // helper's name.
    const links = [...board.matchAll(/`\/group\/\$\{[^}]+\}([^`]*)`/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, rest] of links) expect(rest).toMatch(/^\?\$\{qs\(/);
    // And `qs` itself carries the current period.
    expect(board).toMatch(/period: data\.period\.key/);
    // No campus link may bypass it.
    expect(board).not.toMatch(/href=\{`\/group\/\$\{s\.schoolId\}`\}/);
  });

  it("asks the API for the period it was given", () => {
    expect(campusPage).toMatch(/searchParams\.period/);
    const call = campusPage.match(/apiGet<[^>]*>\>?\(\s*`([^`]*)`/);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/\/group\/schools\/\$\{params\.schoolId\}\?\$\{q\.toString\(\)\}/);
    expect(campusPage).toMatch(/q\.set\("period", searchParams\.period\)/);
  });

  it("goes back to the same group and period, not to a reset list", () => {
    expect(campusPage).toMatch(/back\.set\("period", searchParams\.period\)/);
    expect(campusPage).toMatch(/back\.set\("groupId", searchParams\.groupId\)/);
    expect(campusPage).not.toMatch(/href="\/group"/);
  });
});
