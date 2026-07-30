// CBT exam-hall DTOs (server form; web consumes Serialized<...>).

export interface CbtBankDto {
  id: string;
  name: string;
  subject: string | null;
  /** Curriculum Subject the bank belongs to (required for teacher authors —
   *  a teacher may only author banks for subjects they teach). */
  subjectId: string | null;
  questionCount: number;
  createdAt: Date;
}

/** What the caller may author against: their subjects and classes. School-wide
 *  staff (principal / school_admin) get every subject and class; a teacher gets
 *  only the (subject, class) pairs they actually teach. */
export interface CbtAuthoringOptionsDto {
  schoolWide: boolean;
  subjects: { id: string; name: string }[];
  /** Classes an exam may target. For a teacher, `subjectIds` lists which of
   *  their subjects they teach IN that class (the exam's bank subject must be
   *  one of them); null = unrestricted (school-wide staff). */
  classes: { id: string; name: string; level: number | null; subjectIds: string[] | null }[];
}

export interface CbtExamDto {
  id: string;
  title: string;
  bankId: string;
  classId: string | null;
  questionCount: number;
  durationMinutes: number;
  startAt: Date;
  endAt: Date;
  /** DRAFT | PENDING_APPROVAL | PUBLISHED | CLOSED. Publishing is maker-checker:
   *  DRAFT → (request) PENDING_APPROVAL → (a different reviewer approves) PUBLISHED. */
  status: string;
  /** Answer-key release state: HIDDEN | REQUESTED | RELEASED. Students see the
   *  correct answers ONLY once RELEASED (teacher requests, principal approves). */
  answerRelease: string;
  answersReleasedAt: Date | null;
  /** Sittings taken so far (the per-sitting metering figure). */
  sittings: number;
  /** The CALLER's sitting, when they have one. */
  mySittingId: string | null;
  mySittingStatus: string | null;
}

/** One question as the SITTER sees it: the key (answerIndex) is null until the
 *  sitting is closed — server authority, never a client courtesy. */
export interface CbtSittingQuestionDto {
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number | null;
}

export interface CbtSittingViewDto {
  sittingId: string;
  examId: string;
  examTitle: string;
  /** IN_PROGRESS | SUBMITTED | EXPIRED. */
  status: string;
  startedAt: Date;
  /** Server-computed hard stop for this sitting (min of duration and window end). */
  deadline: Date;
  submittedAt: Date | null;
  score: number | null;
  total: number | null;
  /** { [questionId]: chosenIndex } — the sitter's saved answers. */
  answers: Record<string, number>;
  /** True once the exam's answer key has been released (teacher requested,
   *  principal approved). Until then every question's answerIndex is null even
   *  after the sitting closes — the score alone is visible. */
  answersReleased: boolean;
  questions: CbtSittingQuestionDto[];
}

export interface CbtExamResultRowDto {
  sittingId: string;
  studentId: string;
  studentName: string;
  status: string;
  score: number | null;
  total: number | null;
  startedAt: Date;
  submittedAt: Date | null;
}

export interface CbtExamResultsDto {
  exam: CbtExamDto;
  rows: CbtExamResultRowDto[];
}

/**
 * One question as returned to STAFF for review or authoring.
 *
 * `answerIndex` is present ONLY for someone who may EDIT the bank (an author or
 * a subject teacher, i.e. cbt.manage + bank scope) — they need it to proofread
 * their own key. Read-only reviewers (cbt.review, e.g. the head teacher who
 * approves publishing) get `null`, and STUDENTS never receive this shape at all
 * until a sitting closes. Golden Rule: the key is server-side by default.
 */
export interface CbtQuestionDto {
  id: string;
  prompt: string;
  choices: string[];
  /** Marked correct choice — null unless the caller may edit this bank. */
  answerIndex: number | null;
}

/** A bank plus its questions (staff review view). */
export interface CbtBankQuestionsDto {
  bankId: string;
  bankName: string;
  subject: string | null;
  /** True when the caller may edit — drives whether answers are shown/editable. */
  canEdit: boolean;
  questions: CbtQuestionDto[];
}

// =============================================================================
// Level + topic targeting
// =============================================================================
// A subject bank (e.g. "Physics") serves EVERY class that studies it. Each
// question carries an optional curriculum LEVEL (Class.level — SS1=1, SS2=2 …)
// and an optional TOPIC. An exam for SS1A draws only questions whose level
// matches SS1 or is null ("any level"), so one bank can serve SS1A/SS2A/SS3A
// without duplicating a single question, and a stream (SS1A vs SS1B) shares its
// level's questions automatically.

/** One line of an exam blueprint: draw `count` questions from `topic`. */
export interface CbtBlueprintItem {
  topic: string;
  count: number;
}

/** Max blueprint lines — keeps a paper definition bounded and reviewable. */
export const CBT_BLUEPRINT_MAX_ITEMS = 20;

/** What is actually available to draw for a given exam target. */
export interface CbtAvailabilityDto {
  /** Level resolved from the target class (null when the class has no level). */
  level: number | null;
  /** Questions matching that level (plus any-level questions). */
  available: number;
  /** Per-topic counts within that matching pool, for the blueprint builder. */
  byTopic: { topic: string; available: number }[];
}
