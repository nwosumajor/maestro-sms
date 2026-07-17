// CBT exam-hall DTOs (server form; web consumes Serialized<...>).

export interface CbtBankDto {
  id: string;
  name: string;
  subject: string | null;
  questionCount: number;
  createdAt: Date;
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
  /** DRAFT | PUBLISHED | CLOSED. */
  status: string;
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
