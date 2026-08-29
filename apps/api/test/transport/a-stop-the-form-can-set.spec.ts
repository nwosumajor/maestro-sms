/**
 * The screens that make per-stop fares usable.
 *
 * The API was complete — create a stop, reorder, validate a `stopId` belongs to
 * its route — and the ASSIGNMENT FORM sent no stop, so every rider assigned
 * through the product carried `stopId: null`. On a per-stop route that prices at
 * zero and the fee run passes over them.
 *
 * Built here: a stop picker on assignment (required on such a route), a real
 * form for adding a stop, an editable fare on an existing route, and a warning
 * naming riders who would not be billed.
 *
 * Live, end to end: per-stop route -> two stops -> assign with a stop
 * (`stopName=Ikeja Gate, fareMinor=120000`) -> fee run
 * `{passengersBilled:1, totalBilledMinor:120000, unpriced:0}` -> switch that
 * route to a flat fare. Before, the same route billed nobody in silence.
 */
import { readFileSync } from "fs";
import { join } from "path";

const FORM = readFileSync(
  join(__dirname, "../../../../apps/web/components/transport/TransportManager.tsx"),
  "utf8",
);
/** Comments stripped — a gate must not pass on the prose of its own fix. */
const code = FORM.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a stop the form can set", () => {
  it("sends stopId when assigning", () => {
    expect(code).toMatch(/stopId:\s*needsStop\s*\?\s*aStop\s*:\s*undefined/);
  });

  it("will not assign without a stop on a per-stop route", () => {
    // Optional here would be the defect with a picker next to it.
    //
    // Anchored on the DISABLED expression. My first version matched
    // `needsStop && !aStop` anywhere, which the button's `title` also contains —
    // so removing the guard left the assertion green. Exactly the
    // matched-by-accident shape `assertions-that-match-by-accident` exists for,
    // and only mutation testing told the two apart.
    const disabled = /disabled=\{busy \|\| !aRoute[^}]*\}/.exec(code)?.[0] ?? "";
    expect(disabled).toMatch(/needsStop && !aStop/);
  });

  it("decides that from the ROUTE's fare mode, not a guess", () => {
    expect(code).toMatch(/needsStop\s*=\s*chosenRoute\?\.fareMode\s*===\s*"STOP"/);
  });

  it("says so when a per-stop route has no stops to pick yet", () => {
    expect(code).toMatch(/charges by stop and has no stops yet/);
  });

  it("names the riders a fee run would pass over", () => {
    expect(code).toMatch(/unpricedOn/);
    expect(code).toMatch(/no stop on this per-stop/);
  });

  it("counts only ACTIVE student riders as unpriced", () => {
    // A cancelled assignment is not a rider, and staff are never invoiced.
    const fn = /const unpricedOn[\s\S]*?\.length;/.exec(code)?.[0] ?? "";
    expect(fn).toMatch(/status === "ACTIVE"/);
    expect(fn).toMatch(/passengerType === "STUDENT"/);
    expect(fn).toMatch(/!a\.stopId/);
  });

  it("takes fares in the school's currency, never raw minor units", () => {
    // Both boxes said kobo and posted the number typed. A bursar entering 300
    // meant three hundred naira and got three.
    //
    // Against the STRIPPED source: my first version asserted on the raw file and
    // failed on the comment explaining this very fix — the trap this repo
    // already records for the money-boundary gate.
    expect(code).not.toContain("(kobo)");
    expect(code).toMatch(/Flat fare \(\{region\.currency\}\)/);
    expect(code).toMatch(/Fare \(\{region\.currency\}\)/);
    expect(code).toMatch(/minorFrom\(/);
  });

  it("adds a stop through a form rather than chained prompt() dialogs", () => {
    // prompt() cannot be labelled for a screen reader and cannot validate.
    expect(code).not.toMatch(/prompt\("Stop name/);
    expect(code).not.toMatch(/prompt\("Stop fare/);
    expect(code).toMatch(/id=\{`stop-name-\$\{r\.id\}`\}/);
  });

  it("lets an existing route's fare be corrected", () => {
    expect(code).toMatch(/fareMode:\s*edit\.mode/);
    expect(code).toMatch(/id=\{`fare-mode-\$\{r\.id\}`\}/);
  });
});
