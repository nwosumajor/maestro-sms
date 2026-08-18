// =============================================================================
// Tell somebody only once it is true
// =============================================================================
// `NotificationService.enqueue` opens a transaction of ITS OWN. Called from
// inside a business transaction that has not committed yet, it therefore does
// two wrong things at once:
//
//   1. the notice commits independently, so a later failure in the outer
//      transaction rolls back the FACT and leaves the ANNOUNCEMENT standing —
//      a guardian told their invoice grew by a late fee that does not exist, a
//      family told a waiver was applied that then vanished, a teacher told they
//      were given a discipline case that was never assigned;
//   2. it takes a second connection while the first is still held, and puts a
//      Redis round-trip inside a database transaction that Prisma will abandon
//      after five seconds.
//
// Six call sites did this. The nightly late-fee sweep was the worst: one
// transaction for up to 500 invoices, notifying inside it, so a run that blew
// the 5s cap rolled back every fee and sent every notice — again the next
// night, and the next.
//
// The rule is simple enough to check mechanically: gather WHO to tell inside
// the transaction, do the telling after it returns.
// =============================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

/** Offsets of every `runAsTenant…( … )` call, brace/paren matched so the span
 *  is the real callback and not a fixed lookahead. */
function tenantTxSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of src.matchAll(/runAsTenant\w*\(/g)) {
    const open = src.indexOf("(", m.index ?? 0);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) {
          spans.push([open, j]);
          break;
        }
      }
    }
  }
  return spans;
}

const NOTIFY = /\.(notifications?|notify\w*)\.(enqueue|send)\s*\(/g;

describe("no notification is sent from inside a tenant transaction", () => {
  const files = walk(SRC).filter((p) => !p.includes(`${"notification"}`));

  it("holds across every service", () => {
    const offenders: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      const spans = tenantTxSpans(src);
      if (!spans.length) continue;
      for (const m of src.matchAll(NOTIFY)) {
        const at = m.index ?? 0;
        if (spans.some(([a, b]) => a < at && at < b)) {
          offenders.push(`${p.slice(SRC.length + 1)}:${src.slice(0, at).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner can actually see inside a transaction", () => {
    // A guard that finds nothing because it looks nowhere is worse than none.
    // Same matcher, against something every transaction contains.
    let inside = 0;
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      const spans = tenantTxSpans(src);
      for (const m of src.matchAll(/\btx\.\w+\.(findFirst|create)\s*\(/g)) {
        const at = m.index ?? 0;
        if (spans.some(([a, b]) => a < at && at < b)) inside++;
      }
    }
    expect(inside).toBeGreaterThan(100);
  });
});
