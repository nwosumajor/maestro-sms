// =============================================================================
// The person who approves the correction could not see what was wrong
// =============================================================================
// A head teacher holds `attendance.read` AND `attendance.amend.review` — they
// are the SECOND PERSON on the maker-checker chain that fixes a register more
// than seven days old. The API returned them ZERO classes: they are not in
// attendance's SCHOOL_WIDE_ROLES and supervise no classes of their own, so
// every school-wide attendance read narrowed to nothing and the register board
// rendered empty.
//
// A dead grant of the shape this repo records: a permission has TWO HALVES, the
// route gate saying whether you may read at all and the wide-role set saying
// WHOSE rows — and they had drifted. The failure renders as an empty screen
// rather than a 403, which is why it survives.
//
// It was also a comment claiming an agreement that did not exist. Ten lines
// below the constant, `REGISTER_COVER_ROLES` had said for as long as it existed:
//
//     "Principal, head teacher and junior_admin see every register and can no
//      longer write one"
//
// The intent was always there. The set never implemented it.
//
// WHAT THIS DOES NOT GRANT: cover. `REGISTER_COVER_ROLES` stays school_admin
// alone, because the register is the record of who physically looked at the
// room, and seniority does not confer that.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = stripComments(readFileSync(join(__dirname, "../../src/attendance/attendance.service.ts"), "utf8"));
const PAGE = stripComments(
  readFileSync(join(__dirname, "../../../web/app/(app)/attendance/page.tsx"), "utf8"),
);

/** The literal set, read out of the source — the property is its MEMBERSHIP. */
function roleSet(name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SRC);
  if (!m) throw new Error(`${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("the approver can see what they are approving", () => {
  it("head_teacher sees every register, as the code has always claimed", () => {
    expect(roleSet("SCHOOL_WIDE_ROLES")).toContain("head_teacher");
  });

  it("and so do the roles that already did", () => {
    // The fix ADDS; it must not quietly re-shuffle who else could see.
    const wide = roleSet("SCHOOL_WIDE_ROLES");
    for (const r of ["school_admin", "principal", "junior_admin"]) expect(wide).toContain(r);
  });
});

describe("sight is not cover", () => {
  it("head_teacher still may NOT take another class's register", () => {
    // The register records who physically looked at the room. Cover is an
    // administrative act with a named owner, not something seniority confers.
    expect(roleSet("REGISTER_COVER_ROLES")).toEqual(["school_admin"]);
  });

  it("the two sets are decided separately, so widening one cannot widen the other", () => {
    expect(roleSet("REGISTER_COVER_ROLES").length).toBeLessThan(roleSet("SCHOOL_WIDE_ROLES").length);
  });

  it("super_admin is in NEITHER — a platform operator reads no child's register", () => {
    expect(roleSet("SCHOOL_WIDE_ROLES")).not.toContain("super_admin");
    expect(roleSet("REGISTER_COVER_ROLES")).not.toContain("super_admin");
  });
});

describe("and the board is on the screen for them", () => {
  it("renders for anyone who CHASES a register, not only who takes one", () => {
    // Gated on `attendance.write` alone, the board was invisible to the very
    // person who signs off the amendment when the window has closed.
    expect(PAGE).toMatch(/canChase/);
    expect(PAGE).toMatch(/attendance\.amend\.review/);
    expect(PAGE).toMatch(/\{canChase && <RegisterBoard/);
  });

  it("does not hand them the write-only controls", () => {
    // "Remind teachers now" posts to a route that requires attendance.write; a
    // button that 403s is worse than no button.
    const sweep = PAGE.slice(PAGE.indexOf("register-reminder/run") - 400, PAGE.indexOf("register-reminder/run"));
    expect(sweep).toMatch(/canWrite/);
  });
});
