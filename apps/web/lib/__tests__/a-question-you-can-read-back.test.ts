// =============================================================================
// A question field that grows, and a reader that keeps the line breaks
// =============================================================================
// A question and its options were `<input>` elements on all four surfaces that
// author them. **An `<input>` cannot wrap at any width**: text past the edge
// scrolls sideways out of view, so a teacher writing a two-line question could
// see only a window of it and could not read back what they were about to put
// on a paper a child will sit.
//
// The previous round widened those boxes — `w-32` and `w-24` to full width —
// which helped and could not fix it, because the ELEMENT was the constraint and
// not the pixels. They are `AutoTextarea` now: `field-sizing: content` where
// the browser has it, a `scrollHeight` sync everywhere else.
//
// TWO HALVES, and they only work together:
//
//   WRITING  every prompt, option and mark scheme grows to its content.
//   READING  the moment an author can type a newline, every surface that
//            RENDERS a question must keep it (`whitespace-pre-wrap`) and must
//            wrap a long unbroken token (`break-words`). Without the second
//            half the first one silently loses what was typed.
//
// This is gated rather than remembered because THIS EXACT FEATURE has drifted
// twice already, both recorded: `CbtBankEditor` used full-width rows while
// `CbtStaffPanel` — the form that WRITES questions — laid options out in two
// columns; and the candidate's options were given `break-words` while the
// prompt beside them was left. Four writers and four readers is eight chances
// for the next one to be missed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../test-support/strip-comments";

const WEB = join(__dirname, "..", "..");

/** COMMENTS OUT before scanning.
 *
 *  Every file here EXPLAINS the defect it was fixed for, and the explanations
 *  quote the very class names the gate looks for. Both `whitespace-pre-wrap`
 *  and `scrollHeight` appear in the prose above the code that uses them, so the
 *  first version of this gate passed against a candidate prompt whose wrapping
 *  had been deleted and against a field that had stopped growing — matching its
 *  own commentary. Caught by mutation, and it is the trap `strip-comments.ts`
 *  already exists for on the API side. */


const read = (rel: string) => {
  try { return stripComments(readFileSync(join(WEB, rel), "utf8")); } catch { return ""; }
};

/** Every surface on which a question or an option is TYPED. */
const AUTHORS = [
  "components/cbt/CbtStaffPanel.tsx",      // a teacher writes a paper
  "components/cbt/CbtBankEditor.tsx",      // a teacher corrects a stored question
  "components/operator/QuestionBanks.tsx", // the platform owner's library
  "components/operator/ScholarshipAdmin.tsx", // the scholarship composer
];

/** Every surface on which a question is READ back. */
const READERS = [
  "components/cbt/CbtExamRoom.tsx",       // the candidate sitting it
  "components/cbt/CbtReviewPanel.tsx",    // the reviewer approving the paper
  "components/cbt/CbtMarkingConsole.tsx", // the marker working through scripts
];

/** A JSX tag, read to its matching `>` at brace depth zero.
 *  `<Input[^>]*>` truncates at the first `>` and `onChange={(e) => …}` supplies
 *  one — the trap the accessible-name gate already records. */
function tags(src: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${name}[\\s/>]`, "g");
  for (const m of src.matchAll(open)) {
    let depth = 0;
    let i = m.index!;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

/** Does this tag hold a question, an option, or a mark scheme? */
const CARRIES_PROSE = /aria-label=\{?[`"'][^`"']*\b(Question|Option|Mark scheme)\b|placeholder=\{?[`"'][^`"']*\b([Qq]uestion|Option|Mark scheme)\b|value=\{(q\.prompt|q\.text|prompt|draft\.text|c|value|markGuide)\}/;

describe("a question can be read back by whoever wrote it", () => {
  it("found every surface it names", () => {
    // A walk that reads nothing produces no offenders and passes green.
    for (const rel of [...AUTHORS, ...READERS]) {
      expect([rel, read(rel).length > 500]).toEqual([rel, true]);
    }
  });

  it("no question, option or mark scheme is typed into a single-line input", () => {
    // The defect itself. An <input> cannot wrap, so a long question is
    // unreadable in the box that holds it however wide the box is.
    const offenders: string[] = [];
    for (const rel of AUTHORS) {
      const src = read(rel);
      for (const tag of tags(src, "Input")) {
        if (CARRIES_PROSE.test(tag)) {
          offenders.push(`${rel}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every authoring surface reaches for the shared growing field", () => {
    // The other direction: an empty offender list above also passes for a file
    // that stopped rendering a question at all. And ONE shared control is the
    // point — four private copies is how the two columns and the full-width
    // rows came to disagree in the first place.
    const missing = AUTHORS.filter((rel) => !read(rel).includes("AutoTextarea"));
    expect(missing).toEqual([]);
  });

  it("the growing field really grows, by both mechanisms", () => {
    // `field-sizing` is the native path and is Chromium-first; the scrollHeight
    // sync is what a school's actual device fleet gets. Either alone leaves
    // somebody reading through a one-line window.
    const src = read("components/ui/auto-textarea.tsx");
    expect(src).toMatch(/field-sizing:content|field-sizing", "content/);
    expect(src).toMatch(/scrollHeight/);
    // and it must not be a fixed-height control wearing the name
    expect(src).not.toMatch(/\brows=\{[2-9]/);
  });

  it("every surface that renders a question keeps its line breaks and wraps long words", () => {
    // Once the author can type a newline, a reader without `whitespace-pre-wrap`
    // collapses the question into a paragraph, and one without `break-words`
    // lets a chemical name or a URL run out of the card.
    const offenders: string[] = [];
    for (const rel of READERS) {
      const src = read(rel);
      if (!/whitespace-pre-wrap[^"]*break-words|break-words[^"]*whitespace-pre-wrap/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the candidate's own answer box is not a fixed window either", () => {
    // A theory answer is an essay typed into what was a 9rem box.
    const src = read("components/cbt/CbtExamRoom.tsx");
    expect(src).toMatch(/\[field-sizing:content\]/);
  });
});
