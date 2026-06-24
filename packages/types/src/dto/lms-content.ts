// =============================================================================
// LMS learning content DTOs — materials / lessons / quizzes / forum threads
// =============================================================================
// Approval-gated: content authored by a teacher (own class) or school_admin goes
// DRAFT -> PENDING_APPROVAL -> (principal review) -> PUBLISHED | REJECTED |
// REVISION_REQUESTED. Only PUBLISHED content is visible to enrolled students.
// Quiz definitions + auto-grading and forum posts live here. Server-form (Date
// fields are Date); the web consumes Serialized<…>.
// =============================================================================

export type LmsContentType = "MATERIAL" | "LESSON" | "QUIZ" | "FORUM_THREAD";
export type LmsContentStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "PUBLISHED"
  | "REJECTED"
  | "REVISION_REQUESTED";

export type QuizQuestionType = "MCQ" | "TF" | "SHORT";

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

export interface QuizDefDto {
  questions: QuizQuestionDto[];
}

/** The polymorphic content body (shape depends on `type`). */
export type LmsContentBody =
  | { kind: "MATERIAL"; description?: string }
  | { kind: "LESSON"; html: string }
  | { kind: "QUIZ"; quiz: QuizDefDto }
  | { kind: "FORUM_THREAD"; intro: string };

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
  createdAt: Date;
  updatedAt: Date;
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
}

export interface ForumPostDto {
  id: string;
  authorName: string;
  body: string;
  createdAt: Date;
}
