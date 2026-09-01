/**
 * "You have no children linked" was also what a refusal looked like.
 *
 * `/family/overview` returns 200 and `{ children: [] }` for a parent with no
 * links — the service returns that explicitly and never 404s. So `null` from
 * `apiGet` is never "no children"; it is the API declining to answer, most
 * realistically a 403, which is reachable because the page gates on the
 * SESSION's permissions while the API gates on the DB's and the two can
 * disagree.
 *
 * `?? { children: [] }` collapsed the two into one rendering, and this page
 * renders that as a settled, actionable INFO alert: "Your account isn't linked
 * to any students yet — ask the school office to link you." It sent a parent to
 * ring the school about a link that already exists.
 *
 * NOT a network blip: `apiGet` deliberately THROWS on an unreachable API, a 5xx
 * and a 429, so none of those renders as "no data". Checked rather than assumed
 * — the first draft of this fix said blip and was wrong about the cause.
 */
import { readFileSync } from "fs";
import { stripComments } from "../support/strip-comments";
import { join } from "path";

const PAGE = stripComments(readFileSync(join(__dirname, "../../../../apps/web/app/(app)/family/page.tsx"), "utf8"));
const page = PAGE;
const API = stripComments(readFileSync(join(__dirname, "../../../../apps/web/lib/api.ts"), "utf8"));
const SERVICE = stripComments(readFileSync(join(__dirname, "../../src/parent/parent.service.ts"), "utf8"));

describe("no children is not a failed read", () => {
  it("the page no longer turns a refusal into an empty family", () => {
    expect(page).not.toMatch(/apiGet<Overview>\("\/family\/overview"\)\)? \?\? \{ children: \[\] \}/);
  });

  it("says the system would not answer, and that it is not a claim about the family", () => {
    expect(page).toMatch(/would not answer/i);
    expect(page).toMatch(/NOT a statement that you have no/i);
  });

  it("keeps the genuine empty case, which is a different fact", () => {
    // A parent really can have no links yet, and that message is right for them.
    expect(page).toMatch(/No linked children/);
    expect(page).toMatch(/ask the school office to link you/);
  });

  it("an empty family really is 200 with an empty list, not a 404", () => {
    // The premise. If the service ever started 404ing, `null` would become
    // ambiguous again and this page would need to say less, not more.
    expect(SERVICE).toMatch(/if \(childIds\.length === 0\) return \{ children: \[\] \}/);
  });

  it("apiGet really throws rather than returning null for a dead API", () => {
    // The other half of the premise, and the reason the message says "would not
    // answer" rather than "something went wrong": an unreachable API never
    // reaches this branch at all.
    expect(API).toMatch(/throw new Error\(`API unreachable/);
    expect(API).toMatch(/if \(res\.status >= 500\) throw/);
  });
});
