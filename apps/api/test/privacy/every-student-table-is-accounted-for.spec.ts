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

/**
 * A PUPIL IS ALSO A USER, and this gate could not see that.
 *
 * It derives models with a `studentId` column, which is the right question for
 * most of the schema and blind to the rest: a pupil's own conversations,
 * library loans, movement scans and delivery preferences are keyed on `userId`,
 * `borrowerId` or `memberId`. Found by counting the rows one real pupil
 * actually has, table by table, and reconciling against the artifact — every
 * section matched exactly except `thread_participant = 3`, which appeared in no
 * section and in no exclusion while the bundle said `complete: true`.
 *
 * So the person-keyed models are classified too. Three buckets, and STAFF_ONLY
 * is a real answer rather than an escape hatch: a payslip or a leave request
 * cannot belong to a pupil, and saying so is what stops the list becoming a
 * dumping ground.
 */
const STAFF_ONLY = "(staff-only: a pupil can hold no row here)";

const PERSON_KEYED: Record<string, string> = {
  // --- exported, as a named section -----------------------------------------
  Notification: "notifications",
  ThreadParticipant: "messages",
  BookLoan: "libraryLoans",
  NotificationPreference: "notificationPreferences",
  // --- excluded, with a stated reason ---------------------------------------
  DisciplineComplaint: "disciplineRecords",
  ScanEvent: "movementRecords",
  TransportAssignment: "boardingAndTransport",
  TransportBoarding: "boardingAndTransport",
  Alumnus: "alumniRecord",
  UserRole: "accountRecords",
  LegalAcceptance: "accountRecords",
  IssuedCertificate: "accountRecords",
  DocumentSubmission: "accountRecords",
  GamePlayer: "gamesAndCompetitions",
  GameResult: "gamesAndCompetitions",
  Standing: "gamesAndCompetitions",
  TypingRacer: "gamesAndCompetitions",
  HangmanPlayer: "gamesAndCompetitions",
  LiveQuizParticipant: "gamesAndCompetitions",
  LiveQuizAnswer: "gamesAndCompetitions",
  UltimateEntryLink: "crossSchoolCompetition",
  // Anonymous BY DESIGN — a response cannot be attributed back without undoing
  // the promise made to the pupil when they answered.
  PollVote: "gamesAndCompetitions",
  FormResponse: "gamesAndCompetitions",
  // --- staff-only -----------------------------------------------------------
  Appraisal: STAFF_ONLY,
  BiometricEnrollment: STAFF_ONLY,
  DisciplinaryCase: STAFF_ONLY,
  DutyAssignment: STAFF_ONLY,
  Employee: STAFF_ONLY,
  EmploymentChangeRequest: STAFF_ONLY,
  LeaveBalance: STAFF_ONLY,
  LeaveRequest: STAFF_ONLY,
  LoanRepayment: STAFF_ONLY,
  PayComponent: STAFF_ONLY,
  Payslip: STAFF_ONLY,
  PlatformDelegation: STAFF_ONLY,
  PlatformFeedback: STAFF_ONLY,
  PrivilegeGrant: STAFF_ONLY,
  SchoolGroupDirector: STAFF_ONLY,
  StaffAttendance: STAFF_ONLY,
  StaffChecklist: STAFF_ONLY,
  StaffDocument: STAFF_ONLY,
  StaffExit: STAFF_ONLY,
  StaffLoan: STAFF_ONLY,
  TrainingRecord: STAFF_ONLY,
};

/** Models keyed on a PERSON but not on `studentId`. */
function personKeyedModels(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  // `subjectId` is deliberately NOT in this list: in the academic models it is
  // the school SUBJECT, not a person, and treating it as one put five
  // timetable/syllabus models into a privacy manifest they have no business in.
  const KEYS = ["userId", "recipientId", "borrowerId", "memberId", "respondentId", "passengerId", "againstId", "voterId", "participantId"];
  const out: string[] = [];
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith(".prisma"))) {
    const src = readFileSync(join(SCHEMA_DIR, f), "utf8");
    for (const m of src.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
      if (/^\s*studentId\s+String/m.test(m[2])) continue;
      if (KEYS.some((k) => new RegExp(`^\\s*${k}\\s+String`, "m").test(m[2]))) out.push(m[1]);
    }
  }
  return [...new Set(out)].sort();
}

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

  it("accounts for the person-keyed models too — a pupil is also a user", () => {
    const unaccounted = personKeyedModels().filter((m) => !(m in PERSON_KEYED));
    expect(unaccounted).toEqual([]);
  });

  it("found a believable number of person-keyed models", () => {
    expect(personKeyedModels().length).toBeGreaterThan(20);
  });

  it("every person-keyed bucket is declared in the artifact, or is staff-only", () => {
    const declared = new Set([...sections(), ...exclusions()]);
    const missing = Object.entries(PERSON_KEYED)
      .filter(([, bucket]) => bucket !== STAFF_ONLY && !declared.has(bucket))
      .map(([model, bucket]) => `${model} -> ${bucket}`);
    expect(missing).toEqual([]);
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
