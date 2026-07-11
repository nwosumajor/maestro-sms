// =============================================================================
// LMS learning content DTOs — materials / lessons / quizzes / forum threads
// =============================================================================
// Approval-gated: content authored by a teacher (own class) or school_admin goes
// DRAFT -> PENDING_APPROVAL -> (principal review) -> PUBLISHED | REJECTED |
// REVISION_REQUESTED. Only PUBLISHED content is visible to enrolled students.
// Quiz definitions + auto-grading and forum posts live here. Server-form (Date
// fields are Date); the web consumes Serialized<…>.
// =============================================================================

export type LmsContentType = "MATERIAL" | "LESSON" | "QUIZ" | "FORUM_THREAD" | "VIDEO" | "ASSIGNMENT";

/** Where a VIDEO comes from. Embed providers are canonicalised + host-allowlisted
 *  server-side (only youtube/vimeo) so no arbitrary iframe src ever reaches a
 *  student. FILE is a video uploaded to the tenant's object storage. */
export type VideoProvider = "YOUTUBE" | "VIMEO";
export type LmsContentStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "PUBLISHED"
  | "REJECTED"
  | "REVISION_REQUESTED";

export type QuizQuestionType = "MCQ" | "TF" | "SHORT" | "ESSAY";

/** One quiz question. `answer` is the SERVER-ONLY answer key (never sent to a
 *  student until they've attempted — see LmsContentDto.body redaction). */
export interface QuizQuestionDto {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  /** MCQ options (ignored for TF/SHORT). */
  options?: string[];
  /** Answer key: MCQ = option index as string; TF = "true"/"false"; SHORT = text. */
  answer: string;
  /** Optional marks for this question (default 1). */
  points?: number;
}

export type QuizScoring = "BEST" | "LATEST";

export interface QuizDefDto {
  questions: QuizQuestionDto[];
  /** Availability window (ISO). Attempts before opensAt / after closesAt are rejected. */
  opensAt?: string;
  closesAt?: string;
  /** Max attempts per student (default 1). */
  maxAttempts?: number;
  /** Question bank: draw this many random questions per student (default = all).
   *  The subset is deterministic per student, so it's stable across reloads. */
  drawCount?: number;
  /** Time limit in minutes (advisory/displayed; a soft limit). */
  timeLimitMinutes?: number;
  /** Which attempt counts toward the result (default BEST). */
  scoring?: QuizScoring;
}

/** A lesson is a list of typed, PLAIN-TEXT blocks — never raw HTML. Rendering
 *  the text through auto-escaping React components removes the stored-XSS vector
 *  a free-form HTML body carried (defense in depth: not just the approval gate).
 *  Legacy `{html}` lessons are converted to `paragraph` blocks on read. */
export type LessonBlockType =
  | "heading"
  | "paragraph"
  | "bullets"
  | "numbered"
  | "code"
  | "math"
  | "callout"
  | "quote";
export type LessonBlock =
  | { type: "heading"; text: string; level: 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbered"; items: string[] }
  | { type: "code"; code: string; lang?: string }
  /** TeX source, rendered in a styled math block (KaTeX visual pass is future). */
  | { type: "math"; tex: string }
  | { type: "callout"; text: string; tone: "info" | "warn" | "tip" }
  | { type: "quote"; text: string };

/** The polymorphic content body (shape depends on `type`). */
export type LmsContentBody =
  | { kind: "MATERIAL"; description?: string }
  | { kind: "LESSON"; blocks: LessonBlock[] }
  | { kind: "QUIZ"; quiz: QuizDefDto }
  | { kind: "FORUM_THREAD"; intro: string }
  /** `url` is the CANONICAL, host-allowlisted embed URL (server-normalised). */
  | { kind: "VIDEO"; provider: VideoProvider; url: string; description?: string }
  /** An assignment brief. `dueAt` is an ISO string; `points` is the max mark. */
  | { kind: "ASSIGNMENT"; instructions: string; dueAt?: string; allowLate?: boolean; points?: number };

export type LmsSubmissionStatus = "SUBMITTED" | "GRADED";

/** One student's submission to an ASSIGNMENT (text; file attachment is a follow-up). */
export interface LmsSubmissionDto {
  id: string;
  contentId: string;
  studentId: string;
  studentName: string;
  text: string;
  status: LmsSubmissionStatus;
  /** Mark out of the assignment's `points` (null until graded). */
  grade: number | null;
  feedback: string | null;
  /** True if submitted after the assignment's dueAt. */
  late: boolean;
  submittedAt: Date;
  gradedAt: Date | null;
}

export interface LmsContentDto {
  id: string;
  classId: string;
  type: LmsContentType;
  title: string;
  status: LmsContentStatus;
  authorName: string;
  /** The content body. For a QUIZ shown to a STUDENT, the per-question `answer`
   *  keys are stripped server-side (only the author/staff see the key). */
  body: LmsContentBody;
  /** MATERIAL only: original filename of the uploaded PDF (if any). */
  fileName: string | null;
  /** The linked approval workflow request id, once submitted. */
  approvalRequestId: string | null;
  /** The module/unit this item belongs to, or null (ungrouped / "General"). */
  moduleId: string | null;
  /** Gradebook tag: the subject this QUIZ/ASSIGNMENT counts toward, or null.
   *  A tagged item can be pulled into the term report card's CA component. */
  subjectId: string | null;
  /** Gradebook tag: the term this QUIZ/ASSIGNMENT counts toward, or null. */
  termId: string | null;
  /** For a STUDENT viewer: whether they have marked this item complete. Always
   *  false for staff/parents (not applicable). */
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One student's aggregated LMS score for a (class, subject, term), ready to be
 *  pulled into the report card's "assignment" CA component. Signals for the
 *  teacher — nothing is written to the report card until they apply + publish. */
export interface LmsGradeRowDto {
  studentId: string;
  studentName: string;
  /** Points earned / possible across tagged, PUBLISHED quizzes (best/latest per
   *  quiz per the quiz's own scoring rule) and graded assignments. */
  quizEarned: number;
  quizPossible: number;
  assignmentEarned: number;
  assignmentPossible: number;
  earned: number;
  possible: number;
  /** earned/possible × 100, or null when there is nothing graded yet. */
  percent: number | null;
  /** `percent` scaled to the assignment component's max (e.g. 84% → 8/10), or
   *  null when percent is null. This is what "Apply" writes. */
  suggestedMark: number | null;
  /** The assignment-component mark currently stored on the SubjectResult (null =
   *  nothing applied yet), and the row's publish status, so the UI shows drift. */
  appliedMark: number | null;
  resultStatus: string | null;
}

/** The teacher's "pull LMS scores into the report card" table for one
 *  (class, subject, term). */
export interface LmsGradebookDto {
  classId: string;
  subjectId: string;
  subjectName: string;
  termId: string;
  termName: string;
  /** The assignment component's maximum (the CA slice LMS scores map onto). */
  componentMax: number;
  rows: LmsGradeRowDto[];
}

/** One entry in an LMS content item's version history (staff-only). The body
 *  snapshot stays server-side; the list carries just the metadata. */
export interface LmsRevisionDto {
  id: string;
  contentId: string;
  version: number;
  title: string;
  authorName: string;
  note: string | null;
  createdAt: Date;
}

/** Live/virtual classroom. */
export type LiveProvider = "ZOOM" | "MEET" | "JITSI" | "OTHER";
export type LiveStatus = "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";

/** A scheduled live class session. The `joinUrl` is NOT in the list payload —
 *  it is returned only by the join endpoint (which also records attendance). */
export interface LmsLiveSessionDto {
  id: string;
  classId: string;
  title: string;
  provider: LiveProvider;
  startsAt: Date;
  durationMinutes: number;
  status: LiveStatus;
  hostName: string;
  /** Derived server-side: whether the join window is currently open. */
  joinable: boolean;
  /** Host/staff only: number of students who have joined (0 for others). */
  attendeeCount: number;
  createdAt: Date;
}

/** One student's join record for a live session (host/staff view). */
export interface LmsLiveAttendanceDto {
  studentId: string;
  studentName: string;
  joinedAt: Date;
}

/** xAPI (Tin Can) — the allow-listed verbs the LRS accepts. */
export type XapiVerb =
  | "experienced"
  | "completed"
  | "passed"
  | "failed"
  | "attempted"
  | "answered"
  | "progressed";

export interface XapiResult {
  score?: number | null;
  max?: number | null;
  success?: boolean | null;
  completion?: boolean | null;
  /** Free-form response / detail (kept short). */
  response?: string | null;
}

/** One stored xAPI learning statement (the LRS record, read side). */
export interface XapiStatementDto {
  id: string;
  actorId: string;
  actorName: string;
  verb: XapiVerb;
  objectId: string;
  objectName: string;
  classId: string | null;
  result: XapiResult;
  storedAt: Date;
}

/** An achievement badge a teacher awarded to a student (positive recognition). */
export interface LmsAwardDto {
  id: string;
  classId: string;
  studentId: string;
  studentName: string;
  /** A key from LMS_BADGES; the web resolves its icon/label. */
  badge: string;
  note: string | null;
  awardedByName: string;
  createdAt: Date;
}

/** A module/unit that groups a class's content into an ordered learning path. */
export interface LmsModuleDto {
  id: string;
  classId: string;
  title: string;
  orderIndex: number;
}

/** Per-class learning analytics for a teacher (staff-of-class only). All figures
 *  are SIGNALS for human review — never an automated verdict (Golden Rule #8). */
export interface LmsAnalyticsDto {
  classId: string;
  studentCount: number;
  publishedContent: number;
  contentByType: { type: LmsContentType; count: number }[];
  /** Average completion % across enrolled students, and how many finished all. */
  completion: { avgPercent: number; fullyComplete: number };
  quizzes: {
    contentId: string;
    title: string;
    studentsAttempted: number;
    /** Average of each attempting student's best score %, or null if none yet. */
    avgPercent: number | null;
  }[];
  assignments: {
    contentId: string;
    title: string;
    submitted: number;
    graded: number;
    avgPercent: number | null;
  }[];
  live: { sessions: number; totalJoins: number };
  /** Per-student engagement roll-up + a composite %; low values flag students a
   *  teacher may want to check on (a signal, not a penalty). */
  engagement: {
    studentId: string;
    studentName: string;
    completed: number;
    quizzesTaken: number;
    assignmentsSubmitted: number;
    liveJoined: number;
    engagementPercent: number;
  }[];
}

/** Teacher's per-class completion overview ("who's done what"). */
export interface ClassProgressDto {
  /** Number of PUBLISHED content items in the class (the denominator). */
  totalPublished: number;
  students: { studentId: string; studentName: string; completed: number }[];
}

/** A presigned URL envelope (upload or download). */
export interface LmsPresignDto {
  url: string;
  expiresInSeconds: number;
}

/** The result of auto-grading a quiz attempt. */
export interface QuizAttemptResultDto {
  score: number;
  total: number;
  /** Per-question correctness, in question order (objective questions only). */
  correct: boolean[];
  /** Attempts the student has used, and the cap (for multi-attempt quizzes). */
  attemptsUsed?: number;
  maxAttempts?: number;
  /** True if the quiz has essay questions still awaiting a teacher's marking. */
  pendingManual?: boolean;
}

/** One essay question within an attempt, for a teacher to mark. */
export interface QuizEssayAnswerDto {
  questionId: string;
  prompt: string;
  answer: string;
  points: number;
  grade: number | null;
}

/** A student's quiz attempt as seen by a grading teacher (essays to mark). */
export interface QuizAttemptGradeDto {
  attemptId: string;
  studentId: string;
  studentName: string;
  attemptNo: number;
  status: "GRADED" | "PENDING_MANUAL";
  /** Auto (objective) score, current effective score, and full total. */
  autoScore: number;
  score: number;
  total: number;
  essays: QuizEssayAnswerDto[];
}

export interface ForumPostDto {
  id: string;
  authorName: string;
  body: string;
  createdAt: Date;
}
