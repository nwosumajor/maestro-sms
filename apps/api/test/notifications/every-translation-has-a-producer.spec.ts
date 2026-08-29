/**
 * A TRANSLATION NOBODY SENDS IS NOT A TRANSLATED PRODUCT.
 *
 * `notification-messages.ts` already has a test asserting every entry carries
 * every language — a partial entry "would fall back silently and produce a
 * French inbox with English holes". That guards the SHAPE of an entry and says
 * nothing about whether it is ever used.
 *
 * Measured when this was written: FIVE of the nine entries had no producer at
 * all. The text had been written ahead of the code and never wired, so a
 * francophone family read English for a report card, a meeting confirmation and
 * a cancellation — and the catalogue's own header names the report card as one
 * of the three artifacts that are "close to 100% of what that parent reads".
 *
 * Wiring one of them (`meeting.booked`) then exposed a real defect underneath:
 * the entry is worded for a PARENT, and the producer notified only the teacher,
 * so the parent who booked was never told at all. A dead entry is not merely
 * unused — it is evidence about a message somebody expected to exist.
 *
 * The rule is deliberately NOT "every entry must be used": some are written for
 * a producer that cannot supply their params yet, and deleting the translation
 * would lose work. They must be NAMED, with the reason, so the gap is a
 * decision rather than a silence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkSources } from "../support/api-routes";

const CATALOGUE = join(__dirname, "../../../../packages/types/src/notification-messages.ts");

/**
 * Entries with no producer YET, each with the reason it cannot be wired.
 *
 * An entry may sit here only because its producer cannot supply the params the
 * text needs — never because nobody got round to it.
 */
const AWAITING_A_PRODUCER: Record<string, string> = {
  "exam.scheduled":
    "needs {hall} and {seat}, which only the seating plan knows — the exam notice today is sent before a sitting is seated",
  "reportcard.available":
    "needs {term}, which the Document Vault does not carry; a report card reaches families through document.shared, deliberately, so no alert is sent before real bytes exist",
};

function catalogueKeys(): string[] {
  const src = readFileSync(CATALOGUE, "utf8");
  // The entries of MESSAGES: a quoted dotted key at one indent level, followed
  // by an object carrying a `title`. Anchored so a key inside prose cannot match.
  return [...src.matchAll(/^ {2}"([a-z][a-zA-Z]*\.[a-zA-Z]+)":\s*\{/gm)].map((m) => m[1]);
}

describe("every translation has a producer", () => {
  const sources = walkSources().filter((f) => !f.endsWith(".spec.ts"));
  const code = sources.map((f) => readFileSync(f, "utf8")).join("\n");
  const keys = catalogueKeys();

  it("read a believable catalogue and a believable source tree", () => {
    // A walk that finds nothing produces no offenders and passes covering
    // nothing — the failure `a-gate-must-not-pass-by-finding-nothing` names.
    expect(keys.length).toBeGreaterThan(5);
    expect(sources.length).toBeGreaterThan(100);
  });

  it("names a producer for every catalogue entry, or the reason there is none", () => {
    const orphans = keys.filter((k) => !code.includes(`"${k}"`) && !(k in AWAITING_A_PRODUCER));
    expect(orphans).toEqual([]);
  });

  it("awaits a producer only for entries that still exist", () => {
    // A stale exemption is a hole waiting for the key to be reused — the same
    // rule the audit gate learned when it exempted a route that never existed.
    for (const [key, why] of Object.entries(AWAITING_A_PRODUCER)) {
      expect(keys).toContain(key);
      expect(why.length).toBeGreaterThan(30);
    }
  });

  it("does not let an entry be exempted while it IS being sent", () => {
    // The other direction: once somebody wires one of these, the note beside it
    // becomes a lie about the product.
    for (const key of Object.keys(AWAITING_A_PRODUCER)) {
      expect(code.includes(`"${key}"`)).toBe(false);
    }
  });
});
