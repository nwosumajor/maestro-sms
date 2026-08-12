// =============================================================================
// A staff member who has left cannot sign in
// =============================================================================
// Approving a staff exit closed the EMPLOYMENT record — status, end date, final
// settlement, loans recovered — and stopped there. The ACCOUNT stayed ACTIVE, so
// a teacher who had left could sign in the next morning still holding every
// permission they left with: grades, attendance, student profiles, medical
// records, messaging.
//
// Proven live before the fix: exit raised, approved by a second person, and the
// teacher still logged in, still held `teacher`, and still read student records.
//
// The part that makes it worse than a plain omission: the offboarding checklist
// carried an item called "Revoke system access". It is a tickbox. Ticking it did
// nothing. So an HR clerk closing out a leaver was shown a screen that said the
// access was revoked, by a system that had not revoked it.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endsOnOrBefore, revokeStaffAccessInTx } from "../../src/hr/staff-access";

const USER = "22222222-2222-2222-2222-222222222222";

describe("when access ends", () => {
  const now = new Date("2026-08-12T09:00:00Z");

  it("ends on the last working day itself, not at midnight after it", () => {
    expect(endsOnOrBefore(new Date("2026-08-12T00:00:00Z"), now)).toBe(true);
  });

  it("has ALREADY ended for a day in the past", () => {
    expect(endsOnOrBefore(new Date("2026-07-31T00:00:00Z"), now)).toBe(true);
  });

  it("has NOT ended for someone serving notice", () => {
    // The difference between this feature and a support ticket. A staff exit is
    // normally approved before the person leaves — a month's notice is ordinary
    // — and revoking on approval would lock a teacher out of their own classes
    // for that whole month.
    expect(endsOnOrBefore(new Date("2026-09-30T00:00:00Z"), now)).toBe(false);
  });

  it("compares by DAY, so a time of day cannot flip the answer", () => {
    expect(endsOnOrBefore(new Date("2026-08-12T23:59:00Z"), now)).toBe(true);
    expect(endsOnOrBefore(new Date("2026-08-13T00:00:01Z"), now)).toBe(false);
  });
});

describe("revoking access", () => {
  it("sets the status auth actually checks", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const changed = await revokeStaffAccessInTx({ user: { updateMany } } as never, USER);
    expect(changed).toBe(true);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: "EXITED" });
    expect(updateMany.mock.calls[0][0].data.exitedAt).toBeInstanceOf(Date);
  });

  it("is guarded on ACTIVE, so a replayed sweep cannot overwrite a later status", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const changed = await revokeStaffAccessInTx({ user: { updateMany } } as never, USER);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: USER, status: "ACTIVE" });
    expect(changed).toBe(false); // reports what it DID, not what it looked at
  });

  it("leaves ROLES in place — status is what auth checks", async () => {
    // Keeping them makes reinstating a returner one field rather than a
    // reconstruction from memory, and preserves the record of what they held.
    // The pupil exit makes the same choice; the two must not diverge.
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = { user: { updateMany } };
    await revokeStaffAccessInTx(tx as never, USER);
    expect(Object.keys(tx)).toEqual(["user"]);
  });
});

describe("the exit path is wired to it", () => {
  const src = readFileSync(join(__dirname, "../../src/hr/exit.service.ts"), "utf8");

  it("approving an exit revokes access once the last working day has passed", () => {
    expect(src).toMatch(/endsOnOrBefore\(row\.lastWorkingDay, new Date\(\)\)/);
    expect(src).toMatch(/revokeStaffAccessInTx\(tx, row\.userId\)/);
  });

  it("does it in the SAME transaction as the employment change", () => {
    // Half-applied is the failure mode that matters: employment closed, access
    // open, and nothing to tell anyone the two disagree.
    const decide = src.slice(src.indexOf("async decide"), src.indexOf("/** All exits"));
    const empIdx = decide.indexOf('status: "EXITED", endDate');
    const revIdx = decide.indexOf("revokeStaffAccessInTx");
    expect(empIdx).toBeGreaterThan(-1);
    expect(revIdx).toBeGreaterThan(empIdx);
  });

  it("the daily sweep catches everyone whose notice has since run out", () => {
    const sweep = readFileSync(join(__dirname, "../../src/hr/staff-reminder.service.ts"), "utf8");
    expect(sweep).toMatch(/status: "APPROVED", lastWorkingDay: \{ lte: now \}/);
    expect(sweep).toMatch(/status: "ACTIVE"/); // guarded, so re-running is safe
  });
});

describe("the offboarding checklist no longer claims to have done it", () => {
  it("names the EXTERNAL systems a human must still close", () => {
    // "Revoke system access" was a tickbox over a platform that did nothing.
    // A checklist that appears to cover something is worse than one that omits
    // it, because the omission is at least visible.
    // Scoped to the ITEM LIST, not the whole file — prose explaining the old
    // label would otherwise fail this, and a guard that trips on its own
    // documentation gets weakened until it stops guarding anything.
    const src = readFileSync(join(__dirname, "../../src/hr/staff-lifecycle.service.ts"), "utf8");
    const items = src
      .slice(src.indexOf("DEFAULT_ITEMS"), src.indexOf("const HR_ROLES"))
      .replace(/^\s*\/\/.*$/gm, ""); // the DATA, not the prose explaining it
    expect(items).not.toMatch(/"Revoke system access"/);
    expect(items).toMatch(/"Revoke external access/);
  });
});
