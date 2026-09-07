/**
 * "APPROVAL HISTORY" CRASHED THE PAGE ON EVERY REQUEST.
 *
 * `workflow_audit_log.oldState` is NULLABLE, and it is null on exactly the row
 * every request has: the one written when it was created, which had no previous
 * state. Measured on the live database — 5 of 20 rows null, one per request.
 *
 * `WorkflowTrailEntryDto` declared it `oldState: string`. The wire said null,
 * the type said string, and nothing checks — `apiGet<T>` asserts a shape, it
 * never verifies one. So the component trusted the type and called
 * `t.oldState.replace("_", " ")`, which throws `Cannot read properties of null`
 * the moment the section is expanded.
 *
 * The throw is caught by `app/(app)/error.tsx`, which replaces the WHOLE page
 * with "This page could not be loaded" — which is how a reader experiences it,
 * and why it was reported as a broken page rather than a broken section. It is
 * client-side and only on click, so the page renders 200 server-side, all 15
 * assets load, and the API returns 200 for the list and every detail: none of
 * that could see it.
 */
import { render, screen } from "@testing-library/react";
import { WorkflowTrail } from "../WorkflowChain";

const entry = (oldState: string | null, newState: string) => ({
  at: "2026-09-07T07:38:51.689Z",
  actorName: "Demo Admin",
  oldState,
  newState,
  comments: "created",
});

describe("the approval history's immutable trail", () => {
  it("renders the CREATION entry, whose previous state is null", () => {
    // The row every request has. This threw, and took the page with it.
    render(<WorkflowTrail trail={[entry(null, "DRAFT")]} dateTime={() => "7 Sep 2026"} />);
    expect(screen.getByRole("listitem").textContent).toMatch(/DRAFT/);
    expect(screen.getByRole("listitem").textContent).toMatch(/Demo Admin/);
  });

  it("still shows a transition as one, when there is a previous state", () => {
    render(<WorkflowTrail trail={[entry("PENDING_REVIEW", "APPROVED")]} dateTime={() => "7 Sep 2026"} />);
    expect(screen.getByRole("listitem").textContent).toMatch(/PENDING REVIEW.*→.*APPROVED/);
  });

  it("does not print the word null at a reader", () => {
    render(<WorkflowTrail trail={[entry(null, "DRAFT")]} dateTime={() => "7 Sep 2026"} />);
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
  });

  it("survives a whole request's trail, creation row first", () => {
    render(
      <WorkflowTrail
        trail={[
          entry(null, "DRAFT"),
          entry("DRAFT", "PENDING_REVIEW"),
          entry("PENDING_REVIEW", "APPROVED"),
        ]}
        dateTime={() => "7 Sep 2026"}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  // A sixth test was written here and DELETED: "spells out every underscore,
  // not just the first". The component uses `/_/g` where it used
  // `.replace("_", " ")`, but no workflow state has two underscores — DRAFT,
  // PENDING_REVIEW, REVISION_REQUESTED, APPROVED, REJECTED — so the assertion
  // passed against both, and mutation showed it. A test that cannot fail on the
  // change it names is the "matches by accident" class, and a green tick that
  // guards nothing is worse than no tick. The `/g` stays as defensive spelling;
  // it has no effect today and is not claimed to.
});
