// =============================================================================
// "We don't have that book" — said of 1,600 books the school owns
// =============================================================================
// `/library/books` returned the first 200 titles by name. The search box on
// /library then filtered THOSE 200 in the browser:
//
//     const shown = q.trim() ? books.filter((b) => …includes(q)…) : books;
//
// So a librarian typing a title their school holds was told it does not exist,
// and so was the barcode box behind the lending desk. Measured on an 1,800-title
// secondary: the page received "Focus Title 0001".."Focus Title 0200", and
// searching "Focus Title 1500" found nothing — while the SERVER's own `?q=`
// found it immediately, and had been able to the whole time. A query parameter
// the API accepted that no screen had ever sent.
//
// Two defect classes at once, both named in CLAUDE.md: "a filter applied in
// memory only ever sees the rows that survived the cap", and "a field the API
// accepts that no screen sends is a feature nobody has".
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../..");
const MANAGER = readFileSync(join(WEB, "components/library/LibraryManager.tsx"), "utf8");
const PAGE = readFileSync(join(WEB, "app/(app)/library/page.tsx"), "utf8");

/** Source with comments stripped, so an assertion cannot be satisfied by the
 *  comment explaining its own fix — which has happened in this repo before. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the catalogue is searched where it lives", () => {
  it("the search box asks the SERVER, sending its query", () => {
    const src = code(MANAGER);
    expect(src).toMatch(/\/api\/sms\/library\/books\?/);
    // The typed query really is what goes on the wire.
    expect(src).toMatch(/set\("q",\s*q\.trim\(\)\)/);
  });

  it("does NOT filter the fetched page in the browser", () => {
    // The defect itself. A second filter over one page can only ever narrow
    // what the cap already threw away.
    const src = code(MANAGER);
    expect(src).not.toMatch(/books\.filter\(/);
    expect(src).not.toMatch(/\.some\(\(f\)\s*=>\s*\(f\s*\?\?\s*""\)\.toLowerCase\(\)\.includes/);
  });

  it("says how many titles the school actually holds", () => {
    // 200 of 1,800, with nothing on the screen saying so.
    expect(code(MANAGER)).toMatch(/books\.total/);
  });

  it("pages both lists, and says what is shown out of what there is", () => {
    const src = code(MANAGER);
    expect(src).toMatch(/function Pager\(/);
    expect(src).toMatch(/Showing \{/);
    // ONE pager for both lists — a second copy is how the two drift apart.
    expect((src.match(/<Pager /g) ?? []).length).toBe(2);
    expect((src.match(/function Pager\(/g) ?? []).length).toBe(1);
  });

  it("offers the OVERDUE rows as a filter, not as something to scroll for", () => {
    const src = code(MANAGER);
    expect(src).toMatch(/loanFilter/);
    expect(src).toMatch(/set\("overdue",\s*"1"\)/);
  });
});

describe("what the search card promises, the form can record", () => {
  it("a librarian can enter an author and an ISBN", () => {
    // The card says "By title, author, ISBN, or barcode" and the form beside it
    // took only a title and a barcode — two of the four things it advertises
    // were unstorable. Found by `a-field-no-screen-can-fill-in` the moment the
    // browser-side filter stopped being the web's only mention of `isbn`.
    const src = code(MANAGER);
    expect(src).toMatch(/setBAuthor/);
    expect(src).toMatch(/setBIsbn/);
    expect(src).toMatch(/author:\s*bAuthor\.trim\(\)\s*\|\|\s*null/);
    expect(src).toMatch(/isbn:\s*bIsbn\.trim\(\)\s*\|\|\s*null/);
  });
});

describe("a failed read is not an empty library", () => {
  it("the page hands NULL through rather than coercing it to an empty page", () => {
    // `apiGet` returns null when it could not ask. Coerced to `[]` the screen
    // said "The catalogue is empty" — a statement about the school that nobody
    // here is in a position to make.
    const src = code(PAGE);
    expect(src).not.toMatch(/books\s*\?\?\s*\{/);
    expect(src).not.toMatch(/loans\s*\?\?\s*\{/);
    expect(src).toMatch(/<LibraryManager\s+books=\{books\}\s+loans=\{loans\}/);
  });

  it("the manager accepts null and says it could not load", () => {
    const src = code(MANAGER);
    expect(src).toMatch(/books:\s*Page<Book>\s*\|\s*null/);
    expect(src).toMatch(/does NOT mean it is empty|not mean it is empty/i);
  });
});

describe("the fines strip prints the school's own money", () => {
  it("formats with the currency the REPORT says the figures are in", () => {
    // It read "Fines accrued ₦300,000.00" on a Ghanaian school's page, directly
    // above a loan table printing the same fines as GH₵200.00. The client
    // island was right; the server page beside it was not.
    const src = code(PAGE);
    expect(src).toMatch(/money\(report\.finesAccruedMinor,\s*report\.currency/);
    expect(src).toMatch(/money\(report\.finesCollectedMinor,\s*report\.currency/);
  });

  it("and in the reader's locale, so the strip and the table agree", () => {
    // Currency alone left the strip saying "GHS 300,000.00" above a row saying
    // "GH₵200.00" — the same money, rendered two ways, on one screen.
    const src = code(PAGE);
    expect(src).toMatch(/regionOf\(user\)/);
    expect(src).toMatch(/report\.currency,\s*locale\)/);
  });
});
