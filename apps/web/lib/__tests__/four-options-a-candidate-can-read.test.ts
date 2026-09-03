/**
 * Asked for: a scholarship question is set A to D, not A to E — and the option
 * fields must be wide enough that what is written can be read in full, by the
 * owner writing it and by the candidate sitting it.
 *
 * The composers offered FIVE options in narrow boxes: `w-32` on the bank page
 * and `w-24` in two columns on the programme console, which is about a dozen
 * characters. The school's own CBT editor already had it right — one option per
 * row, full width — and the scholarship composers, which mirror that module,
 * did not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { SCHOLARSHIP_OPTION_COUNT } from "@sms/types";
import { shortOptions } from "@/components/cbt/CbtExamRoom";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const BANKS = read("components/operator/QuestionBanks.tsx");
const ADMIN = read("components/operator/ScholarshipAdmin.tsx");
const ROOM = read("components/cbt/CbtExamRoom.tsx");

describe("a scholarship question is set A to D", () => {
  it("is four, in one shared constant", () => {
    expect(SCHOLARSHIP_OPTION_COUNT).toBe(4);
  });

  // TWO SPELLINGS OF ONE NUMBER is how the two composers would drift.
  it.each([["QuestionBanks", BANKS], ["ScholarshipAdmin", ADMIN]])(
    "%s takes the count from the shared constant", (_n, src) => {
      expect(src).toMatch(/SCHOLARSHIP_OPTION_COUNT/);
      // and no longer hard-codes five lettered fields
      expect(src).not.toMatch(/\["a", "b", "c", "d", "e"\]/);
    },
  );

  // A QUESTION WRITTEN WHEN FIVE WERE OFFERED KEEPS ALL FIVE. Rendering a fixed
  // four would drop the fifth on the next save — the edit-drops-a-field defect
  // this module has already had twice.
  it.each([["QuestionBanks", BANKS], ["ScholarshipAdmin", ADMIN]])(
    "%s pads a stored question rather than truncating it", (_n, src) => {
      expect(src).toMatch(/const opts = \[\.\.\.(q|question)\.options\]/);
      expect(src).toMatch(/while \(opts\.length < (OPTION_COUNT|SCHOLARSHIP_OPTION_COUNT)\) opts\.push\(""\)/);
      expect(src).not.toMatch(/const \[a = "", b = "", c = "", d = "", e = ""\]/);
    },
  );

  // ONE OPTION PER ROW, FULL WIDTH — the layout the school's own CBT editor
  // uses, and the point of the ask.
  it.each([["QuestionBanks", BANKS], ["ScholarshipAdmin", ADMIN]])(
    "%s gives each option a full-width field", (_n, src) => {
      // BOUNDED TO THE OPTION FIELD. A bare search for `flex-1` matched
      // something else in the same file, and a narrow class swapped back onto
      // the option input left it green — matched by accident, caught by
      // mutation. The assertion is the input that CARRIES the option label.
      const field = /<Input\s+className="([^"]+)"\s+aria-label=\{`Option \$\{/;
      const m = field.exec(src);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("flex-1");
      expect(src).not.toMatch(/grid grid-cols-2 gap-2">\s*\n\s*\{\(\["a"/);
    },
  );

  it.each([["QuestionBanks", BANKS], ["ScholarshipAdmin", ADMIN]])(
    "%s names every option field for a screen reader", (_n, src) => {
      expect(src).toMatch(/aria-label=\{`Option \$\{/);
    },
  );
});

describe("a candidate can read the whole option", () => {
  // Two columns are right for "3 / 4 / 5" and wrong for a sentence.
  it("puts long options on their own row", () => {
    expect(shortOptions(["3", "4", "5", "6"])).toBe(true);
    expect(shortOptions(["Paris", "Rome", "Berlin", "Madrid"])).toBe(true);
    expect(
      shortOptions([
        "The mitochondrion is the powerhouse of the cell and makes ATP",
        "Short",
      ]),
    ).toBe(false);
  });

  it("the paper decides the layout, not the other way round", () => {
    expect(ROOM).toMatch(/shortOptions\(q\.choices\) && "sm:grid-cols-2"/);
  });

  // Without `min-w-0` a long word overflows its own button in a flex row.
  it("wraps the option text instead of overflowing", () => {
    expect(ROOM).toMatch(/className="min-w-0 break-words">\{choice\}/);
    // and the letter badge stays beside the FIRST line once it wraps
    expect(ROOM).toMatch(/"flex items-start gap-2 rounded-md border/);
  });
});
