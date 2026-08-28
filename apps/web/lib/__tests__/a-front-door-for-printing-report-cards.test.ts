/**
 * The class-and-term report card console.
 *
 * The API could always print any term — `POST /reportcards/:id/generate?termId=`
 * — and there was no front door: a past term's card could only be produced by
 * finding the pupil, opening their page, scrolling to a panel headed "Remarks"
 * and changing a selector there. Nobody looks under Remarks to print a report
 * card, and there was no way to do a whole class.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filenameFrom } from "../report-card-download";

const WEB = join(__dirname, "../..");
const CONSOLE_TSX = readFileSync(join(WEB, "components/reportcards/ReportCardConsole.tsx"), "utf8");
const PAGE = readFileSync(join(WEB, "app/(app)/reportcards/page.tsx"), "utf8");
const SHELL = readFileSync(join(WEB, "components/shell/AppShell.tsx"), "utf8");
const DOWNLOAD = readFileSync(join(WEB, "lib/report-card-download.ts"), "utf8");

describe("a front door for printing report cards", () => {
  it("takes its roster from the BROADSHEET, not the live class roll", () => {
    // The broadsheet lists whoever has results for that class and term, so a
    // pupil who has since moved class or left still appears on the term they
    // were taught in. The live roll would omit exactly the pupils whose records
    // get chased.
    expect(CONSOLE_TSX).toMatch(/term-results\/broadsheet\?classId=\$\{classId\}&termId=\$\{termId\}/);
  });

  it("passes the chosen term to every print", () => {
    expect(CONSOLE_TSX).toMatch(/downloadReportCard\(r\.studentId, termId\)/);
    expect(CONSOLE_TSX).toMatch(/downloadReportCard\(studentId, termId\)/);
  });

  it("prints a batch SEQUENTIALLY", () => {
    // Each card renders a PDF and writes a vault copy that notifies guardians.
    // Thirty at once would be thirty renders and thirty fan-outs on one click.
    const batch = CONSOLE_TSX.slice(CONSOLE_TSX.indexOf("const printAll"));
    expect(batch).toMatch(/for \(const r of printable\)/);
    expect(batch).not.toMatch(/Promise\.all/);
  });

  it("reports what did NOT print, not just the count that did", () => {
    expect(CONSOLE_TSX).toMatch(/failures\.length === 0/);
    expect(CONSOLE_TSX).toMatch(/failed:/);
  });

  it("names the pupils it is NOT printing for, rather than hiding them", () => {
    expect(CONSOLE_TSX).toMatch(/no published marks for this term/);
  });

  it("does not report a failed read as an empty class", () => {
    // Both halves: the page's own fetch and the console's.
    expect(CONSOLE_TSX).toMatch(/not<\/strong> a report that nobody has marks/);
    expect(PAGE).toMatch(/not<\/strong> a report that there is nothing to print/);
  });

  it("gives every control an accessible name", () => {
    expect(CONSOLE_TSX).toMatch(/htmlFor="rc-class"/);
    expect(CONSOLE_TSX).toMatch(/htmlFor="rc-term"/);
    expect(CONSOLE_TSX).toMatch(/aria-label=\{`Print report card for \$\{r\.studentName\}`\}/);
  });

  it("is nav-gated on the same permission and module as Grades", () => {
    expect(SHELL).toMatch(/key: "reportcards".*perm: "grade.read", module: MODULES\.GRADEBOOK/);
  });

  it("sends a family to their own card instead", () => {
    expect(PAGE).toMatch(/if \(!isStaff\) redirect\("\/gradebook"\)/);
  });
});

describe("the name a card is saved under", () => {
  it("uses the name the SERVER chose", () => {
    // A blob URL carries no headers, so `a.download` wins outright. Both older
    // call sites hard-coded `report-card-${studentId}.pdf`, saving every card
    // under a UUID and discarding the term the server puts in the name.
    expect(DOWNLOAD).toMatch(/filenameFrom\(res\.headers\.get\("content-disposition"\)\)/);
    for (const f of ["components/reportcards/ReportCardButton.tsx", "components/reportcards/RemarksEditor.tsx"]) {
      expect(readFileSync(join(WEB, f), "utf8")).not.toMatch(/a\.download = `report-card-\$\{studentId\}/);
    }
  });

  it("parses the header both quoted and bare", () => {
    expect(filenameFrom('attachment; filename="report-card-ada-term-1.pdf"')).toBe("report-card-ada-term-1.pdf");
    expect(filenameFrom("attachment; filename=report-card-ada.pdf")).toBe("report-card-ada.pdf");
  });

  it("falls back to null rather than guessing", () => {
    // The caller keeps its own default, so an unparseable header degrades to
    // today's behaviour rather than to an empty or partial name.
    for (const h of [null, "", "attachment", 'attachment; filename=""']) {
      expect(filenameFrom(h)).toBeNull();
    }
  });
});
