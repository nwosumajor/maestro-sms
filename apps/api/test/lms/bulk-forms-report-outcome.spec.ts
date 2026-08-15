// =============================================================================
// The two bulk endpoints nobody could reach
// =============================================================================
// Both were built, tested and wired to nothing: the class admin enrolled a class
// of thirty one pupil at a time — thirty round trips and thirty capacity checks
// — and set up a class by submitting the single-subject form nine or ten times.
// They were the last two routes the surface registry tracked as `gap`.
//
// The services were already right, and the UI is built around what they do
// rather than around what a form usually looks like:
//
//   ENROL is idempotent. Already-enrolled pupils are skipped rather than
//   failing, so re-running a roster import is safe — which only helps if the
//   skip is REPORTED, so the screen says "Enrolled 24. 3 were already in this
//   class" and, when nothing was new, says that instead of a cheerful "Done."
//
//   SUBJECTS is all-or-nothing and refuses a batch naming the same subject
//   twice. So the form does not offer a subject already staged on another row:
//   a form that can build an invalid batch is a form that will.
//
// Both stage visibly before committing. A bulk write triggered straight off a
// dropdown is not something an admin can check first.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "../../../web/components/lms");
const ENROL = readFileSync(join(WEB, "BulkEnrol.tsx"), "utf8");
const SUBJECTS = readFileSync(join(WEB, "BulkClassSubjects.tsx"), "utf8");
const PAGE = readFileSync(join(__dirname, "../../../web/app/(app)/classes/page.tsx"), "utf8");
const SERVICE = readFileSync(join(__dirname, "../../src/lms/lms.service.ts"), "utf8");

describe("bulk enrol", () => {
  it("calls the bulk endpoint, not the single one in a loop", () => {
    expect(ENROL).toMatch(/\/api\/sms\/classes\/\$\{classId\}\/enrollments\/bulk/);
  });

  it("reports the skipped count, and says so plainly when nothing was new", () => {
    expect(ENROL).toMatch(/were already in this class/);
    expect(ENROL).toMatch(/out\.enrolled === 0/);
  });

  it("stages pupils visibly before writing", () => {
    // The list is the check: an admin sees exactly who is about to be enrolled.
    expect(ENROL).toMatch(/ready to enrol/);
    expect(ENROL).toMatch(/setStaged\(\(prev\) => prev\.filter/);
  });

  it("refuses to stage the same pupil twice", () => {
    expect(ENROL).toMatch(/already on the list below/);
  });

  it("searches rather than enumerating the roster", () => {
    // This page deliberately does not receive every pupil; a bulk form is no
    // reason to start.
    expect(ENROL).toMatch(/StudentPicker/);
    expect(ENROL).not.toMatch(/students\.map\(\(s\) => <option/);
  });
});

describe("bulk class subjects", () => {
  it("calls the bulk endpoint", () => {
    expect(SUBJECTS).toMatch(/\/api\/sms\/classes\/\$\{classId\}\/subjects\/bulk/);
  });

  it("cannot offer a subject already staged on another row", () => {
    // The server refuses a duplicate subject and writes nothing at all, so the
    // form must not be able to build one.
    expect(SUBJECTS).toMatch(/const taken = new Set\(/);
    expect(SUBJECTS).toMatch(/\.filter\(\(s\) => !taken\.has\(s\.id\)\)/);
  });

  it("omits a blank lessons-per-week and room rather than sending them", () => {
    // Sending a blank would reset a quota somebody had already set — the same
    // care the single-subject form takes.
    expect(SUBJECTS).toMatch(/r\.lessonsPerWeek !== "" \? \{ lessonsPerWeek: Number\(r\.lessonsPerWeek\) \} : \{\}/);
    expect(SUBJECTS).toMatch(/r\.preferredRoomId !== "" \? \{ preferredRoomId: r\.preferredRoomId \} : \{\}/);
  });

  it("only submits rows that have both a subject and a teacher", () => {
    expect(SUBJECTS).toMatch(/rows\.filter\(\(r\) => r\.subjectId && r\.teacherId\)/);
  });

  it("says how many were assigned", () => {
    expect(SUBJECTS).toMatch(/Assigned \$\{out\.assigned\}/);
  });
});

describe("both surface the server's refusal", () => {
  it.each([
    ["enrol", ENROL],
    ["subjects", SUBJECTS],
  ])("%s uses readApiError rather than a generic failure", (_name, src) => {
    // A class at capacity, an unknown pupil, a duplicate subject — the server
    // names each, and those are the messages worth showing.
    expect(src).toMatch(/readApiError\(res\)/);
  });
});

describe("wired to the page beside their single-row siblings", () => {
  it("both render on the classes page", () => {
    expect(PAGE).toMatch(/<BulkEnrol classes=\{classes\}/);
    expect(PAGE).toMatch(/<BulkClassSubjects classes=\{classes\}/);
  });

  it("under the same permission as the single-row form", () => {
    expect(PAGE).toMatch(/\{canWrite && classes && <BulkEnrol/);
    expect(PAGE).toMatch(/canManageSubjects && classes && staff && subjects && \(\s*<BulkClassSubjects/);
  });
});

describe("what the services already guaranteed", () => {
  it("enrol skips the already-enrolled instead of failing", () => {
    const fn = SERVICE.slice(SERVICE.indexOf("async enrollStudentsBulk("), SERVICE.indexOf("async enrollStudentsBulk(") + 1600);
    expect(fn).toMatch(/Already-enrolled students are a no-op, not a failure/);
    expect(fn).toMatch(/ONE capacity check for the whole batch/);
  });

  it("subjects refuses a duplicate and validates everything up front", () => {
    const fn = SERVICE.slice(SERVICE.indexOf("async assignClassSubjectsBulk("), SERVICE.indexOf("async assignClassSubjectsBulk(") + 1400);
    expect(fn).toMatch(/The same subject appears more than once/);
    expect(fn).toMatch(/Validate EVERYTHING first/);
  });
});
