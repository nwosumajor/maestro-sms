// =============================================================================
// The bundle said "complete" and read 8 of the 33 tables keyed on a pupil
// =============================================================================
// `collectStudentBundle` carries a `coverage` manifest, written to remove a real
// ambiguity: a recipient cannot otherwise tell whether `medical: "(not
// included)"` means the pupil has no record or that the exporter could not read
// one. It names the sections it contains and the one it deliberately excludes.
//
// The same ambiguity had simply been left ONE LEVEL UP. It listed ten sections
// and one exclusion, said `complete: true`, and never mentioned that the school
// also holds — keyed on that pupil's own id — the class teacher's written
// remarks, ratings of their character, their subject choices, who it records as
// their guardians, money held in their name, a bank account issued for them,
// their own consent records and their accessibility exemptions.
//
// Remarks and trait ratings are the sharpest case: OPINION data, which a right of
// access covers as squarely as fact, and which the family already reads on every
// report card. Withholding them from the bundle protected nothing and made the
// bundle wrong.
//
// This gate computes the set rather than trusting a hand-kept list, the same way
// the RLS coverage meta-test derives its tables from `pg_class` instead of
// counting them by hand. Every table with a `studentId` column must be either
// EXPORTED as a named section or EXCLUDED with a reason. A new table cannot go
// missing quietly, and the decision has to be written down at the time.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/privacy/privacy.service.ts"), "utf8");
const SCHEMA_DIR = join(__dirname, "../../../../packages/db/prisma/schema");

/** Every model with a `studentId` field, from the Prisma schema. */
function studentKeyedModels(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith(".prisma"))) {
    const src = readFileSync(join(SCHEMA_DIR, f), "utf8");
    for (const m of src.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
      if (/^\s*studentId\s+String/m.test(m[2])) out.push(m[1]);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Each student-keyed model, and how the bundle accounts for it: the section it
 * is exported in, or the `excluded` entry that names why it is not.
 *
 * Written out rather than inferred. Inferring it would let a model drift into
 * the wrong bucket silently, which is the failure this whole file is about.
 */
const ACCOUNTED: Record<string, string> = {
  // --- exported, as a named section -----------------------------------------
  StudentProfile: "profile",
  EmergencyContact: "emergencyContacts",
  MedicalRecord: "medical",
  Enrollment: "enrollments",
  AttendanceRecord: "attendance",
  Invoice: "invoices",
  Document: "documents",
  SubjectResult: "grades",
  ReportCardRemark: "remarks",
  StudentTraitRating: "traitRatings",
  SubjectSelection: "subjectSelections",
  ParentChild: "guardians",
  StudentCreditEntry: "credits",
  StudentVirtualAccount: "virtualAccounts",
  IntegrityConsent: "consents",
  StudentIntegrityExemption: "exemptions",
  // --- excluded, with a stated reason ---------------------------------------
  Submission: "learningActivity",
  LmsSubmission: "learningActivity",
  LmsProgress: "learningActivity",
  LmsLiveAttendance: "learningActivity",
  LmsAward: "learningActivity",
  QuizAttempt: "learningActivity",
  CbtSitting: "learningActivity",
  CbtTheoryAnswer: "learningActivity",
  HostelAllocation: "boardingAndTransport",
  HostelAttendance: "boardingAndTransport",
  HostelExeat: "boardingAndTransport",
  ExamSeat: "examLogistics",
  ExamAttendance: "examLogistics",
  MeetingBooking: "meetings",
  MeetingRequest: "meetings",
  ScholarshipApplication: "scholarshipApplications",
  AttendanceTermRollup: "derivedSummaries",
  ErasureRequest: "erasureRequests",
  UltimateConsent: "crossSchoolCompetition",
};

const sections = () => {
  const block = /sections: \[([\s\S]*?)\]/.exec(SRC);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
};
const exclusions = () => [...SRC.matchAll(/section:\s*"([^"]+)"/g)].map((m) => m[1]);

describe("every table keyed on a pupil", () => {
  const models = studentKeyedModels();

  it("is a set worth checking — the extraction has not silently broken", () => {
    expect(models.length).toBeGreaterThan(20);
  });

  it("is either exported in a named section or excluded with a reason", () => {
    const unaccounted = models.filter((m) => !(m in ACCOUNTED));
    expect(unaccounted).toEqual([]);
  });

  it("names a bucket that the manifest actually declares", () => {
    // A decision recorded here but not in the artifact helps nobody: the reader
    // of the bundle is the person who needs it.
    const declared = new Set([...sections(), ...exclusions()]);
    const dangling = [...new Set(Object.values(ACCOUNTED))].filter((b) => !declared.has(b));
    expect(dangling).toEqual([]);
  });
});

describe("the sections the bundle claims", () => {
  it("includes the opinions held about the pupil", () => {
    // The strongest subject-access case in the whole bundle, and the one that
    // was missing: a written remark and a rating of a child's character.
    expect(sections()).toEqual(expect.arrayContaining(["remarks", "traitRatings"]));
  });

  it("includes what the school records about their family and their money", () => {
    expect(sections()).toEqual(expect.arrayContaining(["guardians", "credits", "virtualAccounts"]));
  });

  it("includes the pupil's own consent and accommodation records", () => {
    // The two things a family is most likely to want proof of.
    expect(sections()).toEqual(expect.arrayContaining(["consents", "exemptions"]));
  });

  it("gives every exclusion a reason, not just a name", () => {
    const entries = [...SRC.matchAll(/section:\s*"([^"]+)",\s*\n\s*reason:\s*\n?\s*"([^"]*)"/g)];
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const [, name, reason] of entries) {
      expect([name, reason.length > 40]).toEqual([name, true]);
    }
  });
});
