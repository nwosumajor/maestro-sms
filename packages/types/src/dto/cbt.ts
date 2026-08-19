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
  /** OBJECTIVE (pick a choice) or THEORY (write an answer). */
  type: string;
  /** Marks this question carries — 1 for objective, the ceiling for theory. */
  maxMarks: number;
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
  /** { [questionId]: text } — the sitter's saved THEORY answers. */
  theoryAnswers: Record<string, string>;
  /**
   * True when the paper contains theory that has not been fully marked, so
   * `score` is only the objective part and must not be shown as final.
   */
  provisional: boolean;
  questions: CbtSittingQuestionDto[];
}

export interface CbtExamResultRowDto {
  sittingId: string;
  studentId: string;
  studentName: string;
  status: string;
  score: number | null;
  total: number | null;
  /** This SCRIPT still has unmarked theory, so its score is the objective part
   *  only. Per-row because marking finishes script by script. */
  provisional: boolean;
  startedAt: Date;
  submittedAt: Date | null;
}

export interface CbtExamResultsDto {
  /**
   * TRUE while any theory answer on this paper is still unmarked.
   *
   * On a paper with a Section B, `score` holds only the OBJECTIVE part until a
   * human marks the theory — so a row reading 12/40 may be a script with 28
   * marks not yet looked at, not a weak candidate. The marking console showed
   * this; the results table every teacher actually opens did not.
   */
  provisional: boolean;
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
  /** Type and metadata, so the edit form can render the right fields. */
  type?: string;
  level?: number | null;
  topic?: string | null;
  maxMarks?: number | null;
  markGuide?: string | null;
  /** A candidate has already SAT this question, so its wording, options and
   *  answer are fixed and it cannot be deleted. Level, topic and mark guide
   *  remain editable. The screen shows this rather than offering a button that
   *  the server would refuse. */
  sat?: boolean;
}

/** A bank plus its questions (staff review view). */
export interface CbtBankQuestionsDto {
  bankId: string;
  bankName: string;
  subject: string | null;
  /** True when the caller may edit — drives whether answers are shown/editable. */
  canEdit: boolean;
  /** An exam on this bank is inside its window. Papers are sampled as each
   *  candidate starts, so the whole bank is frozen until it closes. */
  examOpen?: boolean;
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

// =============================================================================
// Theory (open-response) questions
// =============================================================================
// Theory questions live in the SAME banks as objective ones and reuse the same
// level/topic targeting, so a subject bank can hold SS1 objective and SS2 theory
// side by side and each exam draws what fits its class.
//
// The difference is marking: there is no answer key to compare against, so a
// HUMAN awards the marks. Golden Rule #8 applies literally here — nothing is
// auto-scored, and the mark guide only assists the marker.

export const CBT_QUESTION_TYPES = ["OBJECTIVE", "THEORY"] as const;
export type CbtQuestionType = (typeof CBT_QUESTION_TYPES)[number];

/** Longest answer a candidate may submit for one theory question. */
export const CBT_THEORY_ANSWER_MAX = 20_000;

/** A candidate's answer awaiting (or carrying) a mark, as the MARKER sees it. */
export interface CbtMarkingAnswerDto {
  answerId: string;
  /**
   * Stable pseudonym for this candidate within the exam ("Candidate 7").
   * Marking is anonymous by DEFAULT so a mark is not coloured by who wrote it.
   */
  candidateLabel: string;
  /** The pupil's name — present ONLY once revealed (marking complete, or a
   *  school-wide reveal). Null while anonymous. */
  studentName: string | null;
  text: string;
  marksAwarded: number | null;
  comment: string | null;
  markedAt: Date | null;
}

/** One question's marking queue: the guide, the max, and the answers. */
export interface CbtMarkingQueueDto {
  examId: string;
  questionId: string;
  prompt: string;
  /** The mark scheme — marker-only, never sent to a candidate. */
  markGuide: string | null;
  maxMarks: number;
  marked: number;
  total: number;
  /** True while candidate names are withheld from the marker. */
  anonymous: boolean;
  answers: CbtMarkingAnswerDto[];
}

/** Per-question marking progress for an exam ("Q1 40/40 · Q2 12/40"). */
export interface CbtMarkingProgressDto {
  examId: string;
  /** True while ANY theory answer is unmarked — results stay PROVISIONAL. */
  provisional: boolean;
  questions: {
    questionId: string;
    prompt: string;
    maxMarks: number;
    marked: number;
    total: number;
  }[];
}

// =============================================================================
// Exam integrity (CBT)
// =============================================================================
// What this is and is NOT. It records that a candidate left the exam, and for how
// long, so a human can review it — nothing more. Per Golden Rule #8 there is no
// automatic penalty, no auto-void and no mark deduction; staff see the evidence
// and decide. And per the integrity module's own policy, monitoring is TRANSPARENT:
// the candidate is told on screen that leaving is recorded.
//
// Be clear about its reach: this catches a candidate who tabs away to look
// something up. It cannot see a second device, another person in the room, or a
// browser with scripting disabled. The value is deterrence plus a reviewable
// record — invigilation is what actually prevents those.

/** One client-observed event, batched up and posted periodically. */
export interface CbtIntegrityEventInput {
  /** FOCUS_LOSS (left the tab/app) or PASTE (pasted into a theory answer). */
  type: string;
  /** For FOCUS_LOSS: how long they were away. */
  awayMs?: number;
  /** For PASTE: how many characters arrived at once. */
  chars?: number;
}

/** How many focus losses before staff are notified (once per sitting). */
export const CBT_INTEGRITY_FOCUS_ALERT_COUNT = 3;
/** …or this much cumulative time away, whichever comes first. */
export const CBT_INTEGRITY_FOCUS_ALERT_MS = 60_000;
/** A single absence longer than this is on its own worth a look. */
export const CBT_INTEGRITY_LONG_ABSENCE_MS = 30_000;
/** Cap per POST so a misbehaving client can't flood the signal table. */
export const CBT_INTEGRITY_BATCH_MAX = 25;

/** A candidate's integrity summary on the staff results view. */
export interface CbtIntegritySummaryDto {
  sittingId: string;
  studentId: string;
  studentName: string;
  /** Times they left the exam. */
  focusLosses: number;
  /** Total milliseconds away. */
  awayMs: number;
  /** Large single-event pastes into a theory answer. */
  pastes: number;
  /** True once staff were notified for this sitting. */
  alerted: boolean;
}
