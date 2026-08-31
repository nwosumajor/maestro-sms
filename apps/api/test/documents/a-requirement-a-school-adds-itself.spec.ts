/**
 * ONLY THE SEEDED REQUIREMENTS COULD EVER EXPIRE.
 *
 * `needsExpiry` is what makes a verifier record an expiry date, and
 * `outstandingRequirements` then stops counting the document as held once that
 * date passes — the fix this repo records as "a teaching licence that lapsed,
 * still ticked off as held".
 *
 * `teaching_licence` and `identity_document` are SEEDED with the flag, so that
 * fix worked for them. Both API paths have always accepted `needsExpiry`, and
 * `RequirementsEditor` sent it on NEITHER — so a school's OWN requirement
 * silently never expired, and could not be corrected afterwards either. A
 * safeguarding certificate a school added itself stayed ticked off for ever.
 *
 * Driven live: created the old way -> needsExpiry false; switched on afterwards
 * -> true; created the new way -> true.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EDITOR = readFileSync(
  join(__dirname, "..", "..", "..", "web", "components", "documents", "RequirementsEditor.tsx"),
  "utf8",
);
const CONTROLLER = readFileSync(
  join(__dirname, "..", "..", "src", "documents", "supplied-documents.controller.ts"),
  "utf8",
);

describe("a school can say a document runs out", () => {
  it("sends it when the requirement is created", () => {
    expect(EDITOR).toMatch(/postSms\("documents\/requirements", \{[^}]*needsExpiry[^}]*\}\)/s);
  });

  it("can switch it on for a requirement that already exists", () => {
    // THE REPAIR PATH. Without it a requirement created before anybody thought
    // about expiry could never start tracking it, and the only fix was to stop
    // asking for it and add it again under a new key — losing every document
    // already supplied against the old one.
    expect(EDITOR).toMatch(/patch: \{ active\?: boolean; mandatory\?: boolean; needsExpiry\?: boolean \}/);
    expect(EDITOR).toMatch(/toggle\(r, \{ needsExpiry: !r\.needsExpiry \}\)/);
  });

  it("resets the checkbox after adding, like the other one", () => {
    // Otherwise the next requirement inherits the last one's answer, which is
    // how a school ends up with a birth certificate that expires.
    expect(EDITOR).toContain("setNeedsExpiry(false)");
  });

  it("says what the choice MEANS, not just its name", () => {
    // "Expires" alone is a label; the consequence is that the document stops
    // counting as held, which is the whole reason to set it.
    expect(EDITOR).toMatch(/stops counting as held/);
  });

  it("the API accepted it on both paths all along", () => {
    // Recorded so the fix is not misread as an API change: this was purely a
    // screen that could not reach a field the server already had.
    const create = CONTROLLER.slice(
      CONTROLLER.indexOf("const requirementCreateSchema"),
      CONTROLLER.indexOf("const requirementUpdateSchema"),
    );
    const update = CONTROLLER.slice(
      CONTROLLER.indexOf("const requirementUpdateSchema"),
      CONTROLLER.indexOf("const startUploadSchema"),
    );
    expect(create).toContain("needsExpiry");
    expect(update).toContain("needsExpiry");
  });
});
