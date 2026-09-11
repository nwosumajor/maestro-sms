/**
 * "THIS PAGE COULD NOT BE LOADED" MUST SAY WHICH FAILURE.
 *
 * The signed-in app's boundary showed a `Reference <digest>` line and told the
 * reader to quote it. A digest only exists for a SERVER error — Next redacts
 * the message and substitutes the digest. A CLIENT-side throw (a hydration
 * failure, a chunk that no longer resolves after a redeploy) has NO digest, so
 * the screen rendered the headline and nothing else.
 *
 * Measured the hard way: a report of this exact screen on /workflows, where the
 * page renders 200 server-side under 24 filter combinations and every asset
 * loads — so the throw is client-side, and the one screen that could have named
 * it was the screen showing nothing. The client message is not redacted and is
 * already in that reader's console; putting it on the page is the difference
 * between a report and a shrug.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { stripComments } from "../test-support/strip-comments";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../app/(app)/error.tsx"),
  "utf8",
);
const code = stripComments(SRC);

describe("the signed-in app's error screen", () => {
  it("found the source it is about", () => {
    expect(SRC.length).toBeGreaterThan(800);
  });

  it("still names a server error by its digest", () => {
    expect(code).toMatch(/error\.digest/);
    expect(code).toMatch(/Reference/);
  });

  it("names a CLIENT error by its message, which has no digest", () => {
    expect(code).toMatch(/error\.message/);
    // and offers it as something to quote, like the digest branch
    expect(code.match(/quote this if you report it/g) ?? []).toHaveLength(2);
  });

  it("still says a failure is not an empty result", () => {
    // The sentence the boundary exists for: every page used to swallow failure
    // and render a confident "nothing here".
    expect(SRC).toMatch(/not a report that there is nothing here/);
  });
});
