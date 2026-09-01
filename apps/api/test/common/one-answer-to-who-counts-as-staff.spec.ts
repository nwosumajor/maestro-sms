// =============================================================================
// One answer to "is this person staff"
// =============================================================================
// Five surfaces filter content by a STAFF-vs-family audience: the calendar,
// announcements, forms, polls and discussion groups. Four asked the question by
// EXCLUSION and were right. The calendar asked it with an ALLOW-LIST of six role
// names, and nine staff roles had been added to the platform since it was
// written — so a staff-only event was invisible to the head teacher, the HR
// manager, the librarian, the wardens and the drivers.
//
// All five now call `isStaffRoles`. This gate is about the SIXTH surface.
//
// // GOTCHA, AND THE GATE IS SMALLER BECAUSE OF IT. The first version also tried
// to spot a hand-rolled staff set by its BREADTH — a role Set naming `teacher`
// alongside a back-office role. It flagged exactly one thing,
// `REACHABLE_BY_ANYONE` in messaging, and that set is legitimate and carefully
// reasoned: it answers "who may a pupil or parent open a channel to", is
// explicitly "about a PASTORAL OR OFFICE relationship with families, not about
// seniority", and deliberately excludes the HR manager and the drivers. The
// rule simply does not apply to it.
//
// So the heuristic had a 100% false-positive rate on current code, and the fix
// was to delete it rather than to exempt the one case: an over-wide gate is the
// same failure as a blind one, because it teaches whoever meets it to add an
// exemption, and an exemption granted for a false positive is a hole with a
// note on it. About twenty services keep a narrow "sees EVERY pupil" set
// (SCHOOL_WIDE_ROLES, ROSTER_WIDE_ROLES, LEADERSHIP …) and those are CORRECT as
// allow-lists: adding a role to the platform must NOT silently grant it sight
// of every pupil. Only "is this person staff at all" is defined by exclusion.
// =============================================================================

import { readFileSync } from "node:fs";
import { stripComments } from "../support/strip-comments";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

/**
 * Every surface that filters content by a STAFF-vs-family audience.
 *
 * Named rather than discovered, because that is the honest scope: this is the
 * set of places asking the one question, and a sixth belongs on the list when
 * somebody writes it.
 */
const AUDIENCE_SURFACES = [
  "communication/events.service.ts",
  "announcements/announcements.service.ts",
  "form/form.service.ts",
  "poll/poll.service.ts",
  "discussion/discussion.service.ts",
];

describe("who counts as staff has one definition", () => {
  it("every named surface still exists", () => {
    // A gate naming a file that has moved passes while covering nothing.
    for (const rel of AUDIENCE_SURFACES) {
      expect({ rel, found: stripComments(readFileSync(join(SRC, rel), "utf8")).length > 0 }).toEqual({ rel, found: true });
    }
  });

  it("resolves staffness through the shared helper, never a local role list", () => {
    for (const rel of AUDIENCE_SURFACES) {
      const src = stripComments(readFileSync(join(SRC, rel), "utf8")).replace(/\/\/[^\n]*/g, "");
      expect({ rel, uses: src.includes("isStaffRoles(") }).toEqual({ rel, uses: true });
      // The two shapes this replaced, either of which would drift again.
      expect({ rel, local: /new Set\(\[\s*"student",\s*"parent"\s*\]\)/.test(src) }).toEqual({ rel, local: false });
      expect({ rel, allow: /new Set\(\[[^\]]*"principal"[^\]]*"teacher"/.test(src) }).toEqual({ rel, allow: false });
    }
  });
});
