// =============================================================================
// Term-weighted subject grading — the pure scoring policy + response DTOs.
// =============================================================================
// A student's grade in ONE subject for ONE term is composed of four components,
// each entered as a percentage 0–100 and combined by FIXED weights:
//
//     exam 60%  +  midterm test 20%  +  assignment 10%  +  class note 10%
//
// The weights are named constants here (never hard-coded at a call site) so the
// policy lives in exactly one place and the total is provably 100. All scoring
// is pure and server-authoritative — the API recomputes the total, clients only
// display it. // SECURITY (Golden Rule #8): a grade is only ever a manual
// teacher decision; nothing auto-derives it from telemetry.
// =============================================================================

export const GRADE_COMPONENTS = [
  { key: "exam", label: "Exam", weight: 60 },
  { key: "midterm", label: "Midterm test", weight: 20 },
  { key: "assignment", label: "Assignment", weight: 10 },
  { key: "classNote", label: "Class note", weight: 10 },
] as const;

export type GradeComponentKey = (typeof GRADE_COMPONENTS)[number]["key"];

/** The four component scores. `null` = not yet entered by the teacher. */
export interface TermGradeComponents {
  exam: number | null;
  midterm: number | null;
  assignment: number | null;
  classNote: number | null;
}

export interface TermGradeResult {
  /** Weighted total 0–100. Components not yet entered count as 0. */
  total: number;
  /** True once every component has been entered. */
  complete: boolean;
  /** Letter grade derived from `total` via GRADE_BANDS. */
  grade: string;
}

/** The component weights sum to exactly 100 (asserted at module load so a bad
 *  edit to GRADE_COMPONENTS fails loudly rather than silently mis-weighting). */
export const GRADE_TOTAL_WEIGHT = GRADE_COMPONENTS.reduce((s, c) => s + c.weight, 0);
if (GRADE_TOTAL_WEIGHT !== 100) {
  throw new Error(`GRADE_COMPONENTS weights must sum to 100, got ${GRADE_TOTAL_WEIGHT}`);
}

/** Letter bands, highest threshold first. Total >= min → that grade. */
export const GRADE_BANDS = [
  { min: 70, grade: "A" },
  { min: 60, grade: "B" },
  { min: 50, grade: "C" },
  { min: 45, grade: "D" },
  { min: 40, grade: "E" },
  { min: 0, grade: "F" },
] as const;

function clampPct(v: number | null | undefined): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function gradeLetter(total: number): string {
  for (const band of GRADE_BANDS) {
    if (total >= band.min) return band.grade;
  }
  return "F";
}

/**
 * Pure weighted total for a single subject in a single term. Missing components
 * are treated as 0 so a running total is always meaningful; `complete` flags
 * whether the teacher has entered all four (i.e. whether the total is final).
 */
export function computeTermSubjectGrade(c: TermGradeComponents): TermGradeResult {
  const complete = GRADE_COMPONENTS.every((comp) => {
    const v = c[comp.key];
    return v !== null && v !== undefined;
  });
  const total = round2(
    GRADE_COMPONENTS.reduce(
      (sum, comp) => sum + clampPct(c[comp.key]) * (comp.weight / 100),
      0,
    ),
  );
  return { total, complete, grade: gradeLetter(total) };
}

/** Average of a set of per-term totals (e.g. a session's three terms). */
export function averageOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((s, v) => s + v, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Response DTOs (Date fields are `Date`; the web consumes Serialized<…>).
// ---------------------------------------------------------------------------

/** One subject's grade for one term — the teacher grading unit + the cell a
 *  student/parent sees. */
export interface SubjectResultDto {
  id: string;
  sessionId: string;
  termId: string;
  classId: string;
  subjectId: string;
  subjectName: string;
  studentId: string;
  studentName: string;
  exam: number | null;
  midterm: number | null;
  assignment: number | null;
  classNote: number | null;
  /** Weighted total (null until at least one component is entered). */
  total: number | null;
  grade: string | null;
  /** DRAFT (teacher-only) | PENDING_APPROVAL (awaiting the head-teacher →
   *  principal publish approval) | PUBLISHED (visible to student/parent). */
  status: string;
  gradedById: string | null;
  gradedAt: Date | null;
}

/** A subject row within a term report (student/parent read view). */
export interface TermSubjectRowDto {
  subjectId: string;
  subjectName: string;
  exam: number | null;
  midterm: number | null;
  assignment: number | null;
  classNote: number | null;
  total: number | null;
  grade: string | null;
}

/** One term's worth of subject rows + the term average. */
export interface StudentTermReportDto {
  termId: string;
  termName: string;
  sequence: number;
  subjects: TermSubjectRowDto[];
  average: number | null;
}

// ---------------------------------------------------------------------------
// Per-term subject selection (student picks -> supervisor -> admin/head
// approval -> feeds the grading roster).
// ---------------------------------------------------------------------------

/** Lifecycle: PENDING_SUPERVISOR -> PENDING_ADMIN -> APPROVED | REJECTED.
 *  (PENDING_ADMIN directly when the class has no supervisor assigned.) */
export const SUBJECT_SELECTION_STATUSES = [
  "PENDING_SUPERVISOR",
  "PENDING_ADMIN",
  "APPROVED",
  "REJECTED",
] as const;
export type SubjectSelectionStatus = (typeof SUBJECT_SELECTION_STATUSES)[number];

export interface SubjectSelectionDto {
  id: string;
  sessionId: string;
  termId: string;
  termName: string;
  classId: string;
  className: string;
  studentId: string;
  studentName: string;
  /** The chosen subjects (resolved names for display). */
  subjects: { id: string; name: string }[];
  status: string;
  /** Snapshot of the class supervisor who must pass stage 1 (null = skipped). */
  supervisorId: string | null;
  supervisorName: string | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a student sees when prompted to pick: the current term + the subjects
 *  fixed on their class by admin/principal + any existing selection. */
export interface SubjectSelectionOptionsDto {
  sessionId: string | null;
  sessionName: string | null;
  termId: string | null;
  termName: string | null;
  classId: string | null;
  className: string | null;
  offered: { subjectId: string; subjectName: string; teacherName: string }[];
  selection: SubjectSelectionDto | null;
}

/** One student's row in a subject-teacher's grading roster: their identity plus
 *  the current SubjectResult (null = not graded yet this term). */
export interface GradingRosterStudentDto {
  studentId: string;
  studentName: string;
  admissionNumber: string | null;
  result: SubjectResultDto | null;
}

/** The subject-teacher grading view: every student offering ONE subject in ONE
 *  class for ONE term, with their current component scores. */
export interface GradingRosterDto {
  classId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  sessionId: string;
  termId: string;
  termName: string;
  students: GradingRosterStudentDto[];
}

/** A whole session (first/second/third term) for one student. */
export interface StudentSessionReportDto {
  sessionId: string;
  sessionName: string;
  studentId: string;
  studentName: string;
  className: string | null;
  terms: StudentTermReportDto[];
  sessionAverage: number | null;
}
