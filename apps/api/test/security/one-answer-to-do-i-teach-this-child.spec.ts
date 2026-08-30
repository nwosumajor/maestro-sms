/**
 * ONE ANSWER TO "DO I TEACH THIS CHILD".
 *
 * A class carries a teacher three ways — `class_teacher` (form tutor),
 * `class.supervisorId` (supervisor) and `class_subject_teacher` (subject) — and
 * ten services asked the question with four different answers:
 *
 *   class_teacher only                     /students, search, documents, SIS,
 *                                          notification send
 *   class_teacher + class_subject_teacher  dashboard, messaging, meetings,
 *                                          discipline, staff handover
 *   supervisorId + class_subject_teacher   report-card remarks, trait ratings
 *   (nothing at all)                       what a subject-only teacher got
 *
 * Measured live: of 61 teachers in the demo school ONE is a form tutor and NINE
 * teach only subjects — the normal shape of a secondary school. A teacher with
 * 30 offerings across 899 pupils saw `GET /classes/mine` list their classes and
 * `GET /students` return `[]`, while the SAME person could write those pupils'
 * report-card remarks.
 *
 * This gate is about the DEFINITION not splitting again. It deliberately does
 * not name every caller — that list would rot exactly like the ones it
 * replaced; it asserts instead that nobody derives the answer themselves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkSources } from "../support/api-routes";

const SRC_ROOT = join(__dirname, "../../src");
const strip = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");

/**
 * Files allowed to query a teaching link directly, each with the reason.
 *
 * A reason must say why the question being asked is NOT "which pupils do I
 * teach" — otherwise it is a fifth definition with a note on it.
 */
const MAY_ASK_DIRECTLY: Record<string, string> = {
  "common/teaches.ts": "the one definition itself — every other caller asks it through here",
  "lms/syllabus.service.ts": "asks about ONE OFFERING (class + subject + teacher) — am I the teacher of THIS subject here, which is narrower on purpose",
  "lms/lms.service.ts": "owns the links: creates, lists and removes class/teacher assignments",
  "timetable/timetable.service.ts": "schedules and reassigns the offerings themselves, and answers which CLASSES a family is in",
  "search/search.service.ts": "visibleClassIds answers which CLASSES a caller may see, which is a different question",
  "dashboard/dashboard.service.ts": "counts a teacher's own classes for their tiles, not pupils",
  "communication/messaging.service.ts": "resolves who may open a CHANNEL, which includes staff and is wider than teaching",
  "discipline/discipline.service.ts": "resolves the staff of a class to route a complaint, the reverse lookup",
  "hr/staff-handover.service.ts": "lists what a LEAVER holds, including the offerings themselves",
  "meeting/meeting.service.ts": "resolves a class AUDIENCE for a briefing, not a teaching relationship",
  "gradebook/subject-selection.service.ts": "reads the offerings as the catalogue of subjects a class runs",
  "gradebook/term-result.service.ts": "reads offerings to know which subjects a class is marked in",
  "cbt/cbt.service.ts": "scopes a question bank to the subjects a teacher offers",
  "lms/lms-content.service.ts": "scopes content to the subjects a class offers",
  "reportcards/reportcard.service.ts": "resolves the cohort class printed on a card from the result rows",
};

/**
 * SAME question, not yet moved. A BACKLOG, not a set of exemptions.
 *
 * Each of these asks "which classes are mine" with its own spelling, and most
 * omit at least one link — so a form tutor or a subject teacher is refused
 * something they should reach. They are listed rather than fixed in one commit
 * because each carries its own semantics and would need its own verification;
 * listing them keeps the divergence VISIBLE and stops it growing, which an
 * empty offender list would not.
 */
const AWAITING_CONSOLIDATION: Record<string, string> = {
  "attendance/attendance.service.ts": "the READ scope is consolidated; three other methods still resolve a teacher's own classes for register lists — class_teacher only",
  "gradebook/gradebook.service.ts": "may I grade this class — class_teacher only",
  "integrity/assessment-list.service.ts": "which assessments are mine — class_teacher only",
  "integrity/exemption.service.ts": "may I grant an exemption here — class_teacher only",
  "integrity/integrity.service.ts": "may I read this submission's signals — class_teacher only",
  "game/race.service.ts": "may I open a race for this class — class_teacher only",
  "game/live-quiz.service.ts": "may I host for this class — class_teacher only",
  "game/hangman.service.ts": "may I host for this class — class_teacher only",
  "game/typing-race.service.ts": "may I host for this class — class_teacher only",
  "scholarship/scholarship.service.ts": "which pupils may I nominate — tutor + subject, missing supervisor",
};

describe("one answer to \"do I teach this child\"", () => {
  const files = walkSources(SRC_ROOT);

  it("scanned a believable source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("nobody derives a teacher's pupils for themselves", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC_ROOT.length + 1);
      if (rel in MAY_ASK_DIRECTLY || rel in AWAITING_CONSOLIDATION) continue;
      const src = strip(readFileSync(file, "utf8"));
      // The tell is asking a teaching link BY TEACHER — "which classes are
      // mine". Asking it by CLASS is the reverse lookup and is not this rule.
      if (/\.(classTeacher|classSubjectTeacher)\.find\w+\(\s*\{[^}]*teacherId:\s*p\.userId/.test(src)) {
        offenders.push(`${rel} — derives its own answer instead of common/teaches.ts`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the backlog cannot grow, and every entry still asks the question", () => {
    // If one of these is consolidated, its entry must GO — a list that keeps a
    // name after the reason has gone is the stale exemption this repo keeps
    // finding, and here it would hide a site that had quietly diverged again.
    for (const [rel, why] of Object.entries(AWAITING_CONSOLIDATION)) {
      const src = strip(readFileSync(join(SRC_ROOT, rel), "utf8"));
      expect([rel, /\.(classTeacher|classSubjectTeacher)\.find\w+\(\s*\{[^}]*teacherId:\s*p\.userId/.test(src)]).toEqual([rel, true]);
      expect([rel, why.length > 20]).toEqual([rel, true]);
    }
  });

  it("every exemption names a file that exists, with a real reason", () => {
    for (const [rel, why] of Object.entries(MAY_ASK_DIRECTLY)) {
      expect([rel, readFileSync(join(SRC_ROOT, rel), "utf8").length > 0]).toEqual([rel, true]);
      expect([rel, why.length > 25]).toEqual([rel, true]);
    }
  });

  it("the definition includes all three links", () => {
    // Without this the gate would pass against a helper that quietly narrowed
    // back to one table — every call site would look consolidated and a subject
    // teacher would be blind again.
    const rule = readFileSync(join(SRC_ROOT, "common/teaches.ts"), "utf8");
    for (const link of ["classTeacher", "supervisorId", "classSubjectTeacher"]) {
      expect([link, rule.includes(link)]).toEqual([link, true]);
    }
  });
});
