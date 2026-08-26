// =============================================================================
// A name lookup once per row
// =============================================================================
// `Promise.all(rows.map((r) => this.toDto(tx, r)))` reads as ordinary mapping
// code and is a query multiplier: the mapper takes the transaction, so every
// row it touches costs its own round trips. Three services did it.
//
// Measured live, before and after, as the application role with RLS in force:
//
//   GET /subject-selections   50-row page   205 queries, 211 ms -> 6, 32 ms
//     (term 50 · class 50 · subject 50 · user 55 — and a COHORT shares its
//      term and its class, so 49 of every 50 were the same row fetched again)
//   GET /integrity/exemptions 500 rows      1,507 queries, 654 ms -> 4, 44 ms
//     (501 reads of the exemption table — `toDto(tx, r.id)` RE-FETCHED each row
//      the list already held — plus 1,006 of `user`)
//
// The paging fix that preceded this made the per-row cost matter MORE, not
// less: `PromotionService.list` went from 100 rows to as many as 600.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "src");

/** A per-row async mapper that is genuinely bounded, with the reason. */
const ALLOWED: Record<string, string> = {};

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    out = statSync(p).isDirectory() ? out.concat(walk(p)) : p.endsWith(".ts") ? out.concat(p) : out;
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * `.map(x => this.something(tx, …))` — a method HANDED THE TRANSACTION, once
 * per element. Passing `tx` is the tell: a mapper that needed no database
 * would not ask for one.
 */
const PER_ROW = /\.map\(\s*\(?\s*\w+\s*(?::[^)]*)?\)?\s*=>\s*this\.\w+\(\s*tx\s*,/;

describe("a mapper that is handed the transaction", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".service.ts"));

  it("scanned the services at all", () => {
    // Without this a moved directory turns the assertion below green while
    // covering nothing — `a-gate-must-not-pass-by-finding-nothing`.
    expect(files.length).toBeGreaterThan(80);
  });

  it("is never called once per row", () => {
    const offenders = files
      .filter((f) => PER_ROW.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => f.split("/src/")[1] ?? f)
      .filter((rel) => !(rel in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it("gives every exemption a reason, and none that is now unused", () => {
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(files.some((f) => f.endsWith(rel))).toBe(true);
    }
  });

  it("the three that did it now resolve their names once", () => {
    // Named, so deleting a batch resolver is caught by more than the pattern
    // above — which a refactor could satisfy while reintroducing the cost.
    for (const [file, resolver] of [
      ["gradebook/subject-selection.service.ts", "namesFor"],
      ["integrity/exemption.service.ts", "namesFor"],
      ["lms/promotion.service.ts", "classNamesFor"],
    ]) {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      expect(src).toContain(`private async ${resolver}(`);
      // …and the list path uses it, rather than the single-row mapper.
      expect(src).toMatch(new RegExp(`await this\\.${resolver}\\(tx, `));
    }
  });
});
