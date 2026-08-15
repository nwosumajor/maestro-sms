// =============================================================================
// Every warden in the school was told which child was missing
// =============================================================================
// The hourly sweep alerts staff when a boarder has not signed back in from an
// exeat. The alert names the child and where they went:
//
//     title: `${name} is late back from exeat`
//     body:  `${name} was due back at ... from ${destination} and has not signed in.`
//
// It went to every holder of warden / head_warden / school_admin / principal in
// the school. A warden's authority is their OWN hostel — `assertHostelInScope`
// enforces exactly that on every other hostel read and write, 404 for anything
// else — so this sweep was the one place that ignored the module's own rule, and
// a warden of Hostel B learned that a named child from Hostel A was missing and
// which address they had gone to.
//
// Not a dramatic breach: these are all staff, and the alert is urgent. But it is
// a minor's whereabouts going to somebody with no responsibility for them, in a
// module that is otherwise careful about exactly this, and the fix costs one
// lookup the sweep was already positioned to make.
//
// Head wardens and the school office stay school-wide, because they are
// school-wide by design.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/hostel/exeat-overdue.service.ts"), "utf8");
const HOSTEL = readFileSync(join(__dirname, "../../src/hostel/hostel.service.ts"), "utf8");

describe("who is told a boarder is late back", () => {
  it("the school-wide roles no longer include a plain warden", () => {
    expect(SRC).toMatch(/const SCHOOL_WIDE_ALERT_ROLES = \["head_warden", "school_admin", "principal"\]/);
    expect(SRC).not.toMatch(/ALERT_ROLES = \["warden"/);
  });

  it("the hostel's OWN warden is added per exeat", () => {
    expect(SRC).toMatch(/const warden = wardenOf\.get\(e\.hostelId\)/);
    expect(SRC).toMatch(/\[\.\.\.new Set\(\[\.\.\.schoolWide, \.\.\.\(warden \? \[warden\] : \[\]\)\]\)\]/);
  });

  it("nobody is told twice", () => {
    // A head warden who also wardens this hostel appears in both lists.
    const line = SRC.slice(SRC.indexOf("const recipients ="), SRC.indexOf("const recipients =") + 160);
    expect(line).toMatch(/new Set\(/);
  });

  it("resolves the warden from the hostel, in the same batch as the names", () => {
    // One extra read for the whole school's overdue set, not one per exeat.
    expect(SRC).toMatch(/client\.hostel\.findMany\(\{[\s\S]{0,160}select: \{ id: true, wardenId: true \}/);
  });
});

describe("when there is nobody to tell", () => {
  it("says so per hostel rather than skipping quietly", () => {
    // Introduced by this change and caught while making it: with no school-wide
    // staff and a hostel that has no warden, a `continue` would have dropped the
    // alert in silence — the exact fault this campaign keeps finding.
    expect(SRC).toMatch(/boarder overdue but no warden or administrator to alert/);
  });

  it("still warns for the whole school when nobody at all exists", () => {
    expect(SRC).toMatch(/no head warden, administrator or hostel warden to tell/);
  });

  it("leaves the exeat unmarked so the next hour retries", () => {
    const block = SRC.slice(SRC.indexOf("if (recipients.length === 0)"), SRC.indexOf("if (recipients.length === 0)") + 480);
    expect(block).toMatch(/continue;/);
    expect(block).not.toMatch(/overdueNotifiedAt/);
  });
});

describe("what the alert still is", () => {
  it("stays ESSENTIAL, so a per-type mute cannot silence it", () => {
    expect(SRC).toMatch(/type: "OPERATOR_ALERT"/);
  });

  it("is only marked as sent AFTER it goes out", () => {
    expect(SRC).toMatch(/overdueNotifiedAt/);
  });
});

describe("the rule this now matches", () => {
  it("hostel reads scope a warden to their own hostel", () => {
    // The rule the sweep was the exception to.
    expect(HOSTEL).toMatch(/A warden may only act on their own hostel/);
    expect(HOSTEL).toMatch(/h\.wardenId !== p\.userId\) throw new NotFoundException/);
  });
});
