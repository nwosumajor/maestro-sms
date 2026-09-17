// =============================================================================
// The only place a class can be created had not rendered for anyone
// =============================================================================
// `/classes` gated its create-a-class card on four things:
//
//     {canWrite && classes && students && staff && <ClassAdmin ... />}
//
// and three lines up, `students` was hard-coded:
//
//     // Roster no longer prefetched: the enrol/link controls search on demand.
//     Promise.resolve(null),
//
// So the condition kept a dependency the optimisation had removed, and the card
// could never be true. Not "hard to find" — ABSENT, for every role, since that
// change. A card that does not render looks exactly like a card that was never
// meant to be there, which is why nobody noticed: the page still had plenty on
// it, and the missing thing was the only route to creating a class at all.
//
// THE SHAPE, stated generally: a server page fetches a value as a literal
// `Promise.resolve(null)` — meaning "deliberately not fetched" — and then uses
// that same value as a RENDER CONDITION. The two are contradictory by
// construction, and the failure is silent in both directions: no error, no
// empty state, no test, because every test that renders the page still passes.
// =============================================================================

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readdirSync } from "node:fs";

/** Every .tsx under a directory. `walkTs` matches .ts only, and pages are .tsx —
 *  which is why the first run of this gate scanned nothing and the
 *  "found none" assertion caught it. */
function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTsx(full, out);
    else if (e.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}
import { stripComments } from "../support/strip-comments";

const WEB_APP = join(__dirname, "../../../web/app");

/** Names destructured from `await Promise.all([...])` on a server page. */
function awaitedNames(src: string): string[] {
  const m = /const\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(/.exec(src);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
}

/**
 * Which of those are fetched as a bare `Promise.resolve(null)` — i.e. the page
 * has decided NOT to fetch them. Positional: the nth name pairs with the nth
 * element of the array.
 */
function deliberatelyNull(src: string): string[] {
  const m = /const\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\n\s*\]\);/.exec(src);
  if (!m) return [];
  const names = awaitedNames(src);
  // Split the array at top-level commas only — the elements contain commas of
  // their own inside calls and generics, and a naive split invents entries.
  const body = m[2];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: string[] = [];
  parts.forEach((p, i) => {
    // ONLY the unconditional form. `cond ? apiGet(...) : Promise.resolve(null)`
    // is the normal permission-gated fetch and is not a defect.
    if (/^\s*Promise\.resolve\(null\)\s*$/.test(p) && names[i]) out.push(names[i]);
  });
  return out;
}

describe("a card that can never render", () => {
  const pages = walkTsx(WEB_APP).filter((f) => f.endsWith("page.tsx"));

  it("scanned the server pages — a walk that finds none passes green", () => {
    expect(pages.length).toBeGreaterThan(40);
  });

  it("never gates a component on a value the page deliberately does not fetch", () => {
    const offenders: string[] = [];
    for (const file of pages) {
      const src = stripComments(readFileSync(file, "utf8"));
      const nulls = deliberatelyNull(src);
      if (nulls.length === 0) continue;
      for (const name of nulls) {
        // `{... && name && ... && <Component` — the value standing between the
        // page and a component it renders.
        const gate = new RegExp(`&&\\s*${name}\\s*&&[^)]{0,200}?<[A-Z]`, "s");
        if (gate.test(src)) {
          offenders.push(`${relative(WEB_APP, file)} gates a component on \`${name}\`, which is always null`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
