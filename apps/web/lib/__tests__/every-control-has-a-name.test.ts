// =============================================================================
// "Edit text, blank" — 26 inputs a screen reader could not name
// =============================================================================
// CLAUDE.md commits to accessibility in the integrity module — paste-blocking
// "MUST have an exemption flag per student… or it becomes discriminatory" — and
// that reasoning was never applied to the rest of the UI. Measured across
// apps/web: 26 `<input>` elements with NO accessible name at all. Among them the
// file inputs a parent uses to send in a child's documents, the date filters on
// the attendance register and the exam planner, and the meeting-slot times.
//
// A screen reader announces those as "edit text, blank". A parent uploading a
// birth certificate cannot tell which field is which.
//
// WHAT COUNTS AS A NAME here: aria-label, aria-labelledby, an id (assumed paired
// with a label's htmlFor), or being wrapped in a <label>. A PLACEHOLDER is
// accepted but is not a label — it vanishes the moment somebody types — so it is
// counted separately and reported rather than failed on.
//
// // GOTCHA, and the reason this test parses rather than greps: `<input[^>]*>`
// TRUNCATES A JSX TAG AT THE FIRST `>`, and `onChange={(e) => …}` supplies one.
// My first scan therefore reported inputs that were already labelled — I
// "fixed" one that had `aria-label={isCode ? "2FA code" : "Password"}` further
// down its own tag, and only the TypeScript duplicate-attribute error caught it.
// A tag has to be read to its matching `>` at brace depth zero.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".tsx")) out.push(f);
  }
  return out;
}

/**
 * Comments removed before parsing.
 *
 * // GOTCHA of the same family as the truncated tag: `OpenTournamentForm.tsx`
 * documents its helper with `<input type="datetime-local">` INSIDE a JSDoc
 * block, and a scanner that reads prose as code reports it as an unlabelled
 * control for ever. Nobody can fix that, so the gate would be permanently red
 * for a reason unrelated to accessibility — which is how a gate gets disabled.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every real `<input …>` extent: scan to the matching `>` at brace depth 0. */
function inputTags(src: string): Array<{ at: number; tag: string }> {
  const out: Array<{ at: number; tag: string }> = [];
  for (const m of src.matchAll(/<input\b/g)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        out.push({ at: m.index!, tag: src.slice(m.index!, i + 1) });
        break;
      }
      i += 1;
    }
  }
  return out;
}

/** A `<label>` open with no close between it and this position. */
function wrappedInLabel(src: string, at: number): boolean {
  const before = src.slice(0, at);
  const open = before.lastIndexOf("<label");
  return open !== -1 && !before.slice(open).includes("</label>");
}

const files = walk(WEB);

describe("every text control can be named by a screen reader", () => {
  const silent: string[] = [];
  const placeholderOnly: string[] = [];

  for (const file of files) {
    const src = withoutComments(readFileSync(file, "utf8"));
    for (const { at, tag } of inputTags(src)) {
      // Hidden fields and checkboxes/radios are named by their own labels or
      // are not user-facing text entry.
      if (/type="(hidden|checkbox|radio)"/.test(tag)) continue;
      const named =
        tag.includes("aria-label") ||
        tag.includes("aria-labelledby") ||
        / id=/.test(tag) ||
        wrappedInLabel(src, at);
      const where = `${file.slice(WEB.length + 1)}: ${tag.replace(/\s+/g, " ").slice(0, 60)}`;
      if (named) continue;
      if (tag.includes("placeholder")) placeholderOnly.push(where);
      else silent.push(where);
    }
  }

  it("has no input a screen reader would announce as blank", () => {
    expect(silent).toEqual([]);
  });

  it("reports how many lean on a placeholder alone", () => {
    // Accepted, not failed on: a placeholder IS announced, but it disappears as
    // soon as somebody types, so it is a hint and not a label. Kept visible so
    // the number does not quietly grow.
    // eslint-disable-next-line no-console -- the count is the point
    console.log(`placeholder-only inputs: ${placeholderOnly.length}`);
    expect(placeholderOnly.length).toBeLessThanOrEqual(26);
  });

  it("actually parsed something, rather than matching nothing", () => {
    // The gate's own blind spot, made visible: a parser that silently found no
    // inputs would pass for ever.
    const total = files.reduce((n, f) => n + inputTags(withoutComments(readFileSync(f, "utf8"))).length, 0);
    expect(total).toBeGreaterThan(50);
  });
});
