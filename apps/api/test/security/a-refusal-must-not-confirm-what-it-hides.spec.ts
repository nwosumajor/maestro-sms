// =============================================================================
// A 403 saying "not found" tells you the thing exists
// =============================================================================
// CLAUDE.md states the rule: "Errors never leak cross-tenant existence — return
// 404, not 403". Ninety-seven refusals in the API follow it. Three did not, and
// two of those were in ONE file, forty lines above a sibling that got it right
// and carried a comment explaining exactly why:
//
//     if (!inv) throw new ForbiddenException("Invoice not found");
//     if (!canPay(...)) throw new ForbiddenException("Not your invoice");
//
// TWO THINGS WERE WRONG AND ONLY ONE OF THEM WAS THE STATUS. A `403` whose
// message reads "not found" is self-contradicting — the status confirms the
// record exists while the text denies it. But even with both branches at 403,
// the two MESSAGES differ: "Invoice not found" against "Not your invoice"
// separates an id that exists in the school from one that does not. Making them
// both 403 would never have been enough. The pair has to be indistinguishable in
// status AND in text, or the check is a probe rather than a refusal.
//
// This gate asserts the detectable half — that no refusal contradicts itself —
// and pins the specific pair that was wrong, because the file already proved a
// comment alone does not stop the next occurrence: someone fixed one of the
// three sites, wrote down why, and left the other two.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts")) out.push(f);
  }
  return out;
}

const FILES = walk(SRC);

describe("a refusal about a record the caller may not see", () => {
  it("scanned something — this gate can otherwise pass by finding nothing", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("never carries a 403 with a not-found message", () => {
    // The self-contradicting combination, and the only half a scan can judge
    // without knowing what each check means.
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/throw new ForbiddenException\(\s*[`"']([^`"']*)/g)) {
        if (!/not found|does not exist|no such/i.test(m[1])) continue;
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        offenders.push(`${file.slice(SRC.length + 1)}:${line} — 403 saying "${m[1]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never says 'not your' about a record it has just confirmed exists", () => {
    // The other half of the same leak. A message naming the OWNER of a record
    // tells the caller the record is real; a refusal must not distinguish
    // "somebody else's" from "no such thing".
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/throw new (Forbidden|NotFound)Exception\(\s*[`"']([^`"']*)/g)) {
        if (!/^not your\b/i.test(m[2])) continue;
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        offenders.push(`${file.slice(SRC.length + 1)}:${line} — "${m[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives an invoice the SAME answer whether it is missing or not yours", () => {
    // Pinned specifically, because the comment beside the fixed sibling did not
    // prevent the two beside it from staying wrong for as long as they did.
    const src = readFileSync(join(SRC, "fees/payment-gateway.service.ts"), "utf8");
    const forbidden = src.match(/throw new ForbiddenException\(\s*[`"']Invoice[^`"']*/g) ?? [];
    expect(forbidden).toEqual([]);
    // Every invoice-visibility refusal in the module says the same words.
    const messages = [...src.matchAll(/throw new NotFoundException\(\s*[`"'](Invoice[^`"']*)/g)].map((m) => m[1]);
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(messages)]).toEqual(["Invoice not found"]);
  });
});
