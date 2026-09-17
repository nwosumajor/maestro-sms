// =============================================================================
// The logo a browser was told to save rather than show
// =============================================================================
// A school's logo is presigned in five places and rendered in an <img> in all
// of them. Three asked for an inline grant and two did not — and the two were
// the PUBLIC ones: the login page resolved by slug, and the signed-in member
// shell. Those were handed `Content-Disposition: attachment` plus
// `application/octet-stream` for an image the page was asking the browser to
// DISPLAY, so the custom logo — which is a paid perk, gated on the subscription
// being in good standing — did not appear on the page it was bought for.
//
// Sibling asymmetry, exactly as this repo keeps recording it: the rule was
// reasoned out, written into a comment, applied to the files in front of
// whoever wrote it, and never swept. A sixth correct copy would have been right
// five times, so the presign is now one private method and there is nothing
// left to keep in step.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../support/strip-comments";

const SRC = stripComments(
  readFileSync(join(__dirname, "..", "..", "src", "branding", "branding.service.ts"), "utf8"),
);

describe("every logo URL is signed the same way", () => {
  it("presigns in exactly ONE place", () => {
    // The durable form of the fix. Counting the call sites is the property —
    // five of them is what let three be right and two wrong, and any number
    // above one can drift again.
    const sites = [...SRC.matchAll(/storage\.presignDownload\(/g)];
    expect(sites).toHaveLength(1);
  });

  it("and that place asks for an inline image", () => {
    // Without this the single site could be the WRONG single site, and the test
    // above would still pass while no logo rendered anywhere.
    expect(SRC).toMatch(/presignDownload\(\{\s*key,\s*inline:\s*"image\/png"\s*\}\)/);
  });

  it("routes every caller through it, including the public ones", () => {
    // Named explicitly: these two are the ones that were wrong, and they are
    // the ones a prospective school actually sees.
    const callers = [...SRC.matchAll(/this\.logoUrl\(/g)];
    expect(callers.length).toBeGreaterThanOrEqual(5);
  });
});
