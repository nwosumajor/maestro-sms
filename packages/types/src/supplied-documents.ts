// =============================================================================
// Documents a school ASKS somebody for — and what came back
// =============================================================================
// Two things a school collects before a person joins it: a pupil's birth
// certificate and last report card at admission, a new teacher's CV and
// certificates at hire. Same shape both times — a list of what is expected, a
// file supplied by somebody who does NOT yet have an account, a human check,
// then attachment to the permanent record.
//
// WHAT IS EXPECTED IS DATA, NOT CODE. Schools differ, and the difference is not
// interesting: one wants an immunisation card, another a transfer letter, a
// third a state-of-origin certificate. Those are rows in `document_requirement`,
// not enum members and not a deploy — the same posture as roles, permissions and
// the mobile-money coverage table. What lives here is the STARTING SET a school
// gets on day one, which it is then free to edit.
// =============================================================================

/** Which onboarding a requirement belongs to. */
export const REQUIREMENT_SCOPES = ["STUDENT_ADMISSION", "STAFF_ONBOARDING"] as const;
export type RequirementScope = (typeof REQUIREMENT_SCOPES)[number];

/**
 * Who a submission is about.
 *
 * The first two exist BEFORE the person does — an applicant has no user row, and
 * that is the entire reason submissions are not written straight into the
 * Document Vault. Admissions is deliberately quarantined from student data; a
 * file supplied by a family the school may yet reject must not sit among
 * enrolled pupils' records. On acceptance it is PROMOTED, and the subject
 * becomes the pupil or the staff member.
 */
export const SUBMISSION_SUBJECTS = ["ADMISSION_APPLICATION", "APPLICANT", "STUDENT", "STAFF"] as const;
export type SubmissionSubject = (typeof SUBMISSION_SUBJECTS)[number];

/**
 * PENDING  — metadata written, the browser is uploading to storage.
 * UPLOADED — the object is confirmed present (a HEAD, not a promise).
 * VERIFIED — a person looked at it and accepted it.
 * REJECTED — a person looked at it and did not (reason recorded, resubmit allowed).
 * WAIVED   — the school has decided it will never arrive and that is all right.
 *
 * WAIVED is why `storageKey` is nullable. A birth certificate lost in a flood,
 * with a statutory declaration accepted instead, is an ordinary week in a
 * school office; without it a registrar's outstanding list can never reach zero
 * and stops being read. It is a recorded decision, not a delete.
 */
export const SUBMISSION_STATUSES = ["PENDING", "UPLOADED", "VERIFIED", "REJECTED", "WAIVED"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Statuses that SATISFY a requirement — i.e. stop it being outstanding. */
export const SATISFYING_STATUSES: readonly SubmissionStatus[] = ["UPLOADED", "VERIFIED", "WAIVED"];

/**
 * What a browser may hand us.
 *
 * Parents photograph certificates on a phone; candidates send a PDF. Anything
 * else is refused at the presign, and the magic bytes are checked again on the
 * way in — a Content-Type is a claim by the uploader, not a fact.
 */
export const ACCEPTED_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type AcceptedUploadType = (typeof ACCEPTED_UPLOAD_TYPES)[number];

/** Per-file ceiling. A phone photo is 2–5 MB; a scanned multi-page PDF larger. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How long a family's upload link stays good. Admissions paperwork is slow —
 *  a birth certificate may need a trip to a registry office. */
export const UPLOAD_TOKEN_TTL_DAYS = 30;

/** How long a REJECTED application's supplied files are kept before the sweep
 *  removes them. They are a minor's identity documents belonging to a family
 *  the school turned down; keeping them indefinitely is the thing to avoid. */
export const REJECTED_SUBMISSION_RETENTION_DAYS = 90;

export type RequirementSeed = {
  key: string;
  label: string;
  description: string;
  mandatory: boolean;
  needsExpiry: boolean;
};

/**
 * The starting list for a new school. EDITABLE — every one of these is a row the
 * school may retitle, make optional or switch off, and it may add its own.
 *
 * Deliberately short. A long mandatory list at admission is how a school ends up
 * holding documents it never looks at, and how a family gives up half way.
 */
export const DEFAULT_STUDENT_ADMISSION_REQUIREMENTS: readonly RequirementSeed[] = [
  {
    key: "birth_certificate",
    label: "Birth certificate",
    description: "Or a sworn declaration of age where a certificate is unavailable.",
    mandatory: true,
    needsExpiry: false,
  },
  {
    key: "previous_report_card",
    label: "Last report card from previous school",
    description: "The most recent term or year available. Not required for a first-time entrant.",
    mandatory: false,
    needsExpiry: false,
  },
  {
    key: "transfer_certificate",
    label: "Transfer or leaving certificate",
    description: "From the previous school, where the pupil is transferring in.",
    mandatory: false,
    needsExpiry: false,
  },
  {
    key: "passport_photograph",
    label: "Passport photograph",
    description: "A recent head-and-shoulders photograph for the pupil's record and ID card.",
    mandatory: true,
    needsExpiry: false,
  },
  {
    key: "immunisation_record",
    label: "Immunisation record",
    description: "Where the school or the regulator requires one.",
    mandatory: false,
    needsExpiry: false,
  },
];

export const DEFAULT_STAFF_ONBOARDING_REQUIREMENTS: readonly RequirementSeed[] = [
  {
    key: "cv",
    label: "Curriculum vitae",
    description: "The CV supplied with the application is carried over automatically.",
    mandatory: true,
    needsExpiry: false,
  },
  {
    key: "academic_certificate",
    label: "Highest academic certificate",
    description: "Degree, diploma or equivalent, as awarded.",
    mandatory: true,
    needsExpiry: false,
  },
  {
    key: "teaching_licence",
    label: "Teaching licence or professional registration",
    description: "Where the role requires one. Carries an expiry date.",
    mandatory: false,
    needsExpiry: true,
  },
  {
    key: "identity_document",
    label: "Government identity document",
    description: "National ID, passport or driver's licence.",
    mandatory: true,
    needsExpiry: true,
  },
  {
    key: "reference_letter",
    label: "Reference letter",
    description: "From a previous employer or professional referee.",
    mandatory: false,
    needsExpiry: false,
  },
];

export function defaultRequirements(scope: RequirementScope): readonly RequirementSeed[] {
  return scope === "STUDENT_ADMISSION"
    ? DEFAULT_STUDENT_ADMISSION_REQUIREMENTS
    : DEFAULT_STAFF_ONBOARDING_REQUIREMENTS;
}

/**
 * What is still outstanding for one subject.
 *
 * PURE, and derived rather than stored — the alternative is a per-subject
 * checklist that drifts the moment a requirement is edited, and a registrar
 * reading a list that no longer matches what the school asks for. A requirement
 * switched off stops being outstanding everywhere, at once.
 *
 * A REJECTED submission does NOT satisfy: telling a family "received" for a
 * photograph of somebody's thumb is how a file passes review empty.
 */
export function outstandingRequirements<
  R extends { id: string; key: string; label: string; mandatory: boolean; active: boolean },
  S extends { requirementId: string | null; status: SubmissionStatus },
>(requirements: readonly R[], submissions: readonly S[]): R[] {
  const satisfied = new Set(
    submissions
      .filter((s) => s.requirementId && SATISFYING_STATUSES.includes(s.status))
      .map((s) => s.requirementId as string),
  );
  return requirements.filter((r) => r.active && !satisfied.has(r.id));
}

/** The one-line summary a dashboard shows. `missingMandatory` is the number that
 *  should ever be chased; the rest is context. */
export function submissionProgress<
  R extends { id: string; key: string; label: string; mandatory: boolean; active: boolean },
  S extends { requirementId: string | null; status: SubmissionStatus },
>(
  requirements: readonly R[],
  submissions: readonly S[],
): { required: number; satisfied: number; missingMandatory: number; complete: boolean } {
  const active = requirements.filter((r) => r.active);
  const outstanding = outstandingRequirements(requirements, submissions);
  const missingMandatory = outstanding.filter((r) => r.mandatory).length;
  return {
    required: active.length,
    satisfied: active.length - outstanding.length,
    missingMandatory,
    // COMPLETE means nothing MANDATORY is missing — an optional immunisation
    // record must not keep a pupil's file looking unfinished for ever.
    complete: missingMandatory === 0,
  };
}
