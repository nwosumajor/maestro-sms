/**
 * THE ENGINE OWNS WHEN AN ACTION IS LEGAL, NOT THE INBOX.
 *
 * `WorkflowInbox` derives each row's buttons from `legal` — the entry for that
 * row's state in `WORKFLOW_TRANSITIONS`. The veto button ALSO carried
 * `&& w.state === "APPROVED"`: a second copy of the same rule, in the UI.
 *
 * It was redundant and correct for as long as APPROVED was the only state a
 * veto was legal from. The moment the board could stop a request while it was
 * still under review, that redundant clause made the new power UNREACHABLE FROM
 * ANY SCREEN — the server accepted a veto no button could send. Nothing failed;
 * the feature simply did not appear.
 *
 * This is the mirror of the defect this repo already records the other way
 * round ("gating a route whose UI still calls it"), and the cheaper half to
 * miss, because a missing button reports nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS } from "@sms/types";

const SRC = readFileSync(join(__dirname, "..", "..", "components", "workflow", "WorkflowInbox.tsx"), "utf8");
/** Comments stripped: a gate must not pass on the prose of its own fix. */
const src = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every state the engine can be in, as the UI would spell it. */
const STATES = Object.keys(WORKFLOW_TRANSITIONS);

describe("the workflow inbox asks the engine", () => {
  it("takes its answer from the server, in one of exactly two ways", () => {
    // TWO CORRECT MECHANISMS, and the review actions use the stronger one.
    //
    // `legal` is the row's own entry in WORKFLOW_TRANSITIONS — the engine's
    // transition table. `awaitingMe` is better still: the SERVER's answer to
    // "can this person decide this now", computed with the granular stage
    // permission, whether they already acted, and whether the stage is routed
    // elsewhere. Neither is a rule the component writes for itself.
    //
    // My first version of this test demanded `"X" in legal` for every action
    // and was simply wrong about the component — approve/reject/revise ask
    // `awaitingMe`, which is the answer a transition table cannot give.
    expect(src).toContain('"VETO" in legal');
    expect(src).toContain('"SUBMIT" in legal');
    expect(src).toMatch(/canReview && w\.awaitingMe/);
  });

  it("adds no state condition of its own on top of it", () => {
    // The whole bug: `"VETO" in legal && canVeto && w.state === "APPROVED"`.
    // A second spelling of the rule cannot be kept in step with the first.
    const offenders = STATES.filter((s) => new RegExp(`w\\.state === "${s}"[^\\n]*\\{`).test(src));
    expect(offenders).toEqual([]);
  });

  it("still gates the veto on the PERMISSION, which is a different question", () => {
    // WHO may veto and WHEN a veto is legal are separate, and only the second
    // belongs to the engine. Removing this would offer the button to everyone.
    expect(src).toContain('"VETO" in legal && canVeto');
  });

  it("offers the veto in every state the engine allows one", () => {
    const legalFrom = Object.entries(WORKFLOW_TRANSITIONS)
      .filter(([, actions]) => "VETO" in (actions as Record<string, unknown>))
      .map(([state]) => state);
    // Both, today — and the point is that the component needs no edit when that
    // set changes, because it reads the set.
    expect(legalFrom.sort()).toEqual(["APPROVED", "PENDING_REVIEW"]);
  });

  it("names the two vetoes differently, because they do different things", () => {
    // Stopping a request and recording an objection to one already carried out
    // are not the same act, and one button label for both is the false
    // statement the notice underneath it was fixed for.
    expect(src).toMatch(/stopping\s*\?/);
    expect(src).toContain("nothing has taken effect");
    expect(src).toContain("does NOT undo what the approval already did");
    // COMPUTED FROM THE ROW, never a constant. `const stopping = false` leaves
    // both branches and both strings in place and passed everything above —
    // the same mutation that got past the DTO capability flag in this repo.
    // Every row would then read "does not undo", which is the false statement
    // the split exists to remove.
    expect(src).toMatch(/const stopping = w\.state === "PENDING_REVIEW"/);
  });
});
