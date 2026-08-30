/**
 * The manual promised a power the button does not have.
 *
 * `/help` told a board member: "On any approval workflow you may exercise a
 * veto". Two things wrong with one sentence.
 *
 * It is NOT on any workflow. `WORKFLOW_TRANSITIONS` allows VETO from APPROVED
 * and from nowhere else, so there is nothing to veto while a request is still
 * being reviewed — and a board member looking for the button on a pending row
 * would not find it.
 *
 * And it reads as a reversal. A veto lands AFTER the approval has taken effect —
 * the role was granted, the charges are on families' invoices, the marks are
 * published — and every reactor is `if (state !== "APPROVED") return`, so the
 * REJECTED fan-out it produces is a no-op. Proven live: a vetoed junior-admin
 * appointment left the role on the account.
 *
 * The notification says so now. The one document that explains the power to the
 * person who holds it said the opposite by omission, and somebody who believes
 * the button undoes the act will not go and ask anyone to undo it.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { WORKFLOW_TRANSITIONS } from "@sms/types";

const HELP = readFileSync(join(__dirname, "../../../../apps/web/app/(app)/help/page.tsx"), "utf8");
const MANUAL = readFileSync(join(__dirname, "../../../../docs/ONBOARDING-MANUAL.html"), "utf8");
/** Comments stripped: a gate must not pass on the prose of its own fix. */
const help = HELP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("what the board is told a veto does", () => {
  it("VETO is reachable from PENDING_REVIEW as well as APPROVED", () => {
    // THE PREMISE, AND IT CHANGED. This asserted `["APPROVED"]` — the one moment
    // a veto cannot work, since every reactor has already run by then. That is
    // now the SECOND of two: the board can stop a request under review, where
    // the veto is a real control, and can still record disapproval of one
    // already approved. This test failing is what forced the guide and the
    // manual to move with the behaviour, which is exactly why it exists.
    const from = Object.entries(WORKFLOW_TRANSITIONS)
      .filter(([, actions]) => "VETO" in (actions as Record<string, unknown>))
      .map(([state]) => state)
      .sort();
    expect(from).toEqual(["APPROVED", "PENDING_REVIEW"]);
  });

  it("a veto from REVISION_REQUESTED or DRAFT is still refused", () => {
    // Nothing has been put to the board yet, so there is no decision to veto —
    // and widening it there would let a veto pre-empt the initiator's own
    // resubmission.
    for (const state of ["DRAFT", "REVISION_REQUESTED", "REJECTED"] as const) {
      expect("VETO" in (WORKFLOW_TRANSITIONS[state] as Record<string, unknown>)).toBe(false);
    }
  });

  it("no longer tells the board it works on any workflow", () => {
    expect(help).not.toMatch(/On any approval workflow you may exercise a veto/);
  });

  it("says a veto does not undo what the approval already did", () => {
    expect(help).toMatch(/does not (undo|reverse)/i);
  });

  it("says what to do instead, rather than only what it cannot do", () => {
    // A limitation with no next step leaves the reader stuck.
    expect(help).toMatch(/ask the relevant office to reverse it/i);
  });

  it("the onboarding manual says the same thing", () => {
    // Two documents describing one power, and they must not drift: the manual
    // is what a school owner reads before anyone signs in.
    // BOTH halves of the power, because the manual now describes both and a
    // reader who sees only the second would think the veto never works.
    expect(MANUAL).toMatch(/still under review[^<]*STOPS it/i);
    expect(MANUAL).toMatch(/already been approved[^<]*does not undo what the approval did/i);
  });
});
