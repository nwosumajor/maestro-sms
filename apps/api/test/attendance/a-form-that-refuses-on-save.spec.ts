// =============================================================================
// The register a principal could fill in and could not save
// =============================================================================
// Who may TAKE a register is the class's NAMED supervisor, plus school_admin as
// cover. Principal, head teacher and junior_admin SEE every register and write
// none — the record attests "I looked at this room and these children were
// there", and cover is an administrative act with a named owner rather than
// something seniority confers.
//
// But `attendance.write` is held by the principal, and the page gated the
// register FORM on that permission. So a principal could open /attendance, pick
// a class, mark every pupil, press Save — and be told "Only History 101's class
// teacher takes its register". The whole job done, then refused.
//
// That is the dead-grant shape this repo records: a permission has TWO halves,
// the route gate and the row scope, and they drift. It showed up as a form that
// fails on submit rather than a control that is simply absent.
//
// THE RULE WAS ALSO WRITTEN TWICE — once in `assertCanTakeRegister` (what the API
// enforces) and once inline in the by-class board's `canTake` (what the UI
// offers) — while the outstanding-register board had no such field at all and
// drew a "take" control for everybody. One function now, called by all three.
//
// // Verified live: a principal is 403 on a class they do not supervise and 201
// // the moment they ARE named its supervisor. So a teaching head needs no
// // exception; what seniority does not confer is signing for a room unseen.
// =============================================================================

import { canTakeRegister } from "../../src/attendance/attendance.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const who = (roles: string[], userId = "u-me"): Principal => ({
  schoolId: "S",
  userId,
  roles,
  permissions: ["attendance.read", "attendance.write"],
});

const SUPERVISOR = "u-teacher";

describe("who may take a register", () => {
  it("the class's NAMED supervisor, whatever their role", () => {
    // Responsibility, not rank — this is what makes a teaching head work
    // without an exception.
    expect(canTakeRegister(who(["teacher"], SUPERVISOR), SUPERVISOR)).toBe(true);
    expect(canTakeRegister(who(["principal"], SUPERVISOR), SUPERVISOR)).toBe(true);
  });

  it("school_admin, as cover for any class", () => {
    expect(canTakeRegister(who(["school_admin"]), SUPERVISOR)).toBe(true);
    expect(canTakeRegister(who(["school_admin"]), null)).toBe(true);
  });

  it("NOT the principal or head teacher on a class they do not supervise", () => {
    // They see every register. They sign none they did not witness.
    expect(canTakeRegister(who(["principal"]), SUPERVISOR)).toBe(false);
    expect(canTakeRegister(who(["head_teacher"]), SUPERVISOR)).toBe(false);
    expect(canTakeRegister(who(["junior_admin"]), SUPERVISOR)).toBe(false);
  });

  it("NOT a teacher who is not the supervisor", () => {
    expect(canTakeRegister(who(["teacher"]), SUPERVISOR)).toBe(false);
  });

  it("NOT anybody, on a class with NO supervisor — except the cover role", () => {
    // A class nobody is responsible for is an assignment problem, not a cover
    // problem: the board says "no class teacher" rather than offering a button.
    expect(canTakeRegister(who(["teacher"]), null)).toBe(false);
    expect(canTakeRegister(who(["principal"]), null)).toBe(false);
    expect(canTakeRegister(who(["school_admin"]), null)).toBe(true);
  });

  it("NOT super_admin, who is in neither set", () => {
    // A platform operator has no business recording which named child was in a
    // classroom. The supported route is impersonation: step-up gated, audited.
    expect(canTakeRegister(who(["super_admin"]), SUPERVISOR)).toBe(false);
    expect(canTakeRegister(who(["super_admin"]), null)).toBe(false);
  });

  it("is the SAME function the enforcement and both boards call", () => {
    // The durable half. Two copies of one rule is how a screen comes to offer a
    // button the server refuses — which is exactly what happened on the
    // outstanding-register board, whose rows had no `canTake` at all.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "..", "src", "attendance", "attendance.service.ts"),
      "utf8",
    ) as string;
    // The rule is spelled ONCE; every other site calls it.
    const spelled = [...src.matchAll(/REGISTER_COVER_ROLES\.has/g)].length;
    expect(spelled).toBe(1);
    // ...and the three readers call it.
    expect([...src.matchAll(/canTakeRegister\(/g)].length).toBeGreaterThanOrEqual(4);
  });
});
