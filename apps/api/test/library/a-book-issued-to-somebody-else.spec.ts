import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `LibraryService.issue` has ALWAYS supported two audiences, and its route says
 * so: "librarians (library.manage) to anyone; students (library.borrow) self
 * only." The service enforces exactly that.
 *
 * The only control on the page was **"Issue to me"**, posting `{ bookId }`. So a
 * librarian could not lend a book to a pupil through the product at all — the
 * central act of running a library — and `borrowerId` sat in the API accepting
 * a value no screen could send.
 *
 * THE BUTTON WAS NOT THE WHOLE GAP, which is why this is a route and not a
 * dropdown. There was no data source a librarian could use either:
 *   * `GET /users` is gated on `class.write` — create classes, enrol pupils,
 *     assign teachers. Not a permission a librarian holds to look up a borrower.
 *   * `GET /students` is relationship-scoped, and a librarian teaches nobody, so
 *     it returns an empty list to them.
 *   * The ID-card scan desk is gated on CERTIFICATE, a PREMIUM add-on, and
 *     LIBRARY is in the STANDARD floor — routing the lending desk through it
 *     would make a paid module a prerequisite for issuing a book.
 * Measured live before: `GET /users?kind=student` as the librarian -> 403.
 */

const src = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CONTROLLER = src("apps", "api", "src", "library", "library.controller.ts");
const SERVICE = src("apps", "api", "src", "library", "library.service.ts");
const UI = src("apps", "web", "components", "library", "LibraryManager.tsx");

describe("the lending desk can name a borrower", () => {
  it("has a lookup of its own rather than widening somebody else's", () => {
    expect(CONTROLLER).toMatch(/@Get\("borrowers"\)/);
    // The desk's OWN permission. Widening `class.write` to librarians, or the
    // scan desk's CERTIFICATE gate, were the two alternatives and both are
    // worse than a narrow route.
    expect(CONTROLLER).toMatch(
      /@Get\("borrowers"\)\s*\n\s*@RequirePermission\(LIBRARY_PERMISSIONS\.LIBRARY_MANAGE\)/,
    );
  });

  it("is closed to a pupil, who holds library.borrow", () => {
    // A borrower list gated on `library.borrow` would let any pupil enumerate
    // the school through the lending desk.
    expect(CONTROLLER).not.toMatch(
      /@Get\("borrowers"\)\s*\n\s*@RequirePermission\(LIBRARY_PERMISSIONS\.LIBRARY_BORROW\)/,
    );
  });

  it("returns strictly less than the picker it replaces", () => {
    // Name, admission number and pupil-or-staff. No email, no roles, no
    // contact details — the FIELD-level question this repo keeps relearning.
    const method = SERVICE.slice(SERVICE.indexOf("async listBorrowers"));
    const body = method.slice(0, method.indexOf("\n  }"));
    expect(body).toMatch(/select: \{ id: true, name: true \}/);
    expect(body).not.toMatch(/email/);
    expect(body).not.toMatch(/roles/);
    expect(body).not.toMatch(/phone/);
  });

  it("offers nobody who has left", () => {
    const method = SERVICE.slice(SERVICE.indexOf("async listBorrowers"));
    expect(method.slice(0, method.indexOf("\n  }"))).toMatch(/status: "ACTIVE"/);
  });

  it("resolves admission numbers in ONE query, never per row", () => {
    const method = SERVICE.slice(SERVICE.indexOf("async listBorrowers"));
    const body = method.slice(0, method.indexOf("\n  }"));
    expect(body).toMatch(/studentProfile\.findMany\(\{[\s\S]{0,120}?studentId: \{ in: ids \}/);
    expect(body).not.toMatch(/for \(const u of users\)/);
  });

  it("is bounded, because a picker listing a whole school is unusable", () => {
    const method = SERVICE.slice(SERVICE.indexOf("async listBorrowers"));
    expect(method.slice(0, method.indexOf("\n  }"))).toMatch(/take: BORROWER_PAGE/);
  });
});

describe("the page sends the borrower it found", () => {
  it("posts borrowerId when one is chosen, and omits it otherwise", () => {
    // Omitting is what makes "Issue to me" still work for a pupil, and the
    // service defaults `borrowerId` to the caller.
    expect(UI).toMatch(/borrower \? \{ bookId, borrowerId: borrower\.id \} : \{ bookId \}/);
  });

  it("offers the picker only to a librarian", () => {
    // Offering it to a pupil would show a control whose route answers 403 —
    // the defect this repo keeps recording in both directions.
    expect(UI).toMatch(/\{canManage && \(\s*<Card>[\s\S]{0,400}?Who is borrowing\?/);
  });

  it("does not read a failed lookup as 'nobody by that name'", () => {
    // That would send a librarian looking for a pupil who is standing there.
    expect(UI).toMatch(/Nobody has been ruled out/);
  });
});
