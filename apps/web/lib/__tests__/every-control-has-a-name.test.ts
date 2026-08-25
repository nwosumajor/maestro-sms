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

/** Every real `<input …>` / `<select …>` / `<textarea …>` extent: scan to the
 *  matching `>` at brace depth 0. */
function controlTags(src: string, name: string): Array<{ at: number; tag: string }> {
  const out: Array<{ at: number; tag: string }> = [];
  for (const m of src.matchAll(new RegExp(`<${name}\\b`, "g"))) {
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

/**
 * The shadcn primitives, which FORWARD props rather than being controls.
 *
 * `ui/textarea.tsx` has no label of its own and should not: its callers supply
 * one, and hard-coding a name there would put the same wrong label on every
 * textarea in the app.
 */
const PRIMITIVES = ["components/ui/textarea.tsx", "components/ui/input.tsx"];

const CONTROLS = ["input", "select", "textarea"];

describe("every text control can be named by a screen reader", () => {
  const silent: string[] = [];
  const placeholderOnly: string[] = [];

  for (const file of files) {
    const src = withoutComments(readFileSync(file, "utf8"));
    if (PRIMITIVES.some((q) => file.endsWith(q))) continue;
    for (const { at, tag } of CONTROLS.flatMap((c) => controlTags(src, c))) {
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
    const total = files.reduce(
      (n, f) => n + CONTROLS.reduce((k, c) => k + controlTags(withoutComments(readFileSync(f, "utf8")), c).length, 0),
      0,
    );
    expect(total).toBeGreaterThan(150);
  });
});

// =============================================================================
// The same question, asked of the controls people PRESS
// =============================================================================
// The gate above covers text entry. It said nothing about buttons, and 13 of
// them had no accessible name at all: eight `✕` buttons that REMOVE something
// (a fee line, a pay component, a duty, an award, a lesson block, an
// instalment, a biometric device, an enrolment), `↑`/`↓` for reordering, and
// `P`/`L`/`A` on the staff attendance register.
//
// A screen reader announces `✕` as "multiplication sign" and `P` as "P". The
// user is told a control exists and not what it does — and every one of the
// eight destroys a record. Each label now names WHAT it acts on, because the
// label is heard out of visual context: "Remove instalment 2", not "Remove".
// =============================================================================

/** The children of an element opening at `at`, or "" for a self-closing tag. */
function childrenOf(src: string, at: number, tag: string, open: string): string {
  if (open.trimEnd().endsWith("/>")) return "";
  let depth = 0;
  let i = at;
  while (i < src.length) {
    const nextOpen = src.indexOf(`<${tag}`, i);
    const nextClose = src.indexOf(`</${tag}>`, i);
    if (nextClose === -1) return "";
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 1;
    } else {
      depth -= 1;
      if (depth === 0) return src.slice(at + open.length, nextClose);
      i = nextClose + 1;
    }
  }
  return "";
}

/** Does this markup announce any words to a screen reader? */
function announcesText(children: string): boolean {
  // Anything explicitly hidden from assistive tech announces nothing.
  const visible = children
    .replace(/<(\w+)[^>]*aria-hidden[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*aria-hidden[^>]*\/?>/g, " ");
  // A quoted string with real words (a ternary's arms, say).
  if (/["'`][^"'`]*[A-Za-z]{2,}[^"'`]*["'`]/.test(visible)) return true;
  // A rendered expression — `{s.name}` puts SOMETHING there.
  if (/\{[^{}]*\w+[^{}]*\}/.test(visible)) return true;
  // Bare text between tags.
  return /[A-Za-z]{2,}/.test(visible.replace(/<[^>]*>/g, " "));
}

/** The shadcn Button forwards children, exactly as Input/Textarea forward props. */
const PRESSABLE_PRIMITIVES = ["components/ui/button.tsx"];
const PRESSABLE = ["button", "Button"];

describe("every control you can press can be named by a screen reader", () => {
  const silent: string[] = [];
  let total = 0;

  for (const file of files) {
    if (PRESSABLE_PRIMITIVES.some((q) => file.endsWith(q))) continue;
    const src = withoutComments(readFileSync(file, "utf8"));
    for (const tagName of PRESSABLE) {
      for (const { at, tag } of controlTags(src, tagName)) {
        total += 1;
        if (/aria-label|aria-labelledby|\btitle=/.test(tag)) continue;
        if (announcesText(childrenOf(src, at, tagName, tag))) continue;
        silent.push(`${file.slice(WEB.length + 1)}: ${tag.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
  }

  it("has no button a screen reader would announce as unlabelled", () => {
    expect(silent).toEqual([]);
  });

  it("actually parsed something, rather than matching nothing", () => {
    // Same blind spot as above: a parser finding no buttons would pass for ever.
    expect(total).toBeGreaterThan(500);
  });
});
