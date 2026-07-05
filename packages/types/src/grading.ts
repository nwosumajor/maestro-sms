// =============================================================================
// Term-weighted subject grading — the pure scoring policy + response DTOs.
// =============================================================================
// A student's grade in ONE subject for ONE term is composed of four components.
// Each is a RAW MARK the teacher awards out of that component's maximum, and the
// maxima are chosen so the four add up to exactly 100 for the term:
//
//     exam /60  +  midterm test /20  +  assignment /10  +  class note /10  = /100
//
// So the term total is simply the SUM of the four marks (never a re-weighting of
// percentages): a student who scores full marks everywhere gets 60+20+10+10 =
// 100. The maxima live here as named constants (never hard-coded at a call site)
// so the policy is in one place and the total is provably 100. All scoring is
// pure and server-authoritative — the API recomputes the total, clients only
// display it. // SECURITY (Golden Rule #8): a grade is only ever a manual
// teacher decision; nothing auto-derives it from telemetry.
// =============================================================================

export const GRADE_COMPONENTS = [
  { key: "exam", label: "Exam", max: 60 },
  { key: "midterm", label: "Midterm test", max: 20 },
  { key: "assignment", label: "Assignment", max: 10 },
  { key: "classNote", label: "Class note", max: 10 },
] as const;

export type GradeComponentKey = (typeof GRADE_COMPONENTS)[number]["key"];

/** The four component marks. `null` = not yet entered by the teacher. */
export interface TermGradeComponents {
  exam: number | null;
  midterm: number | null;
  assignment: number | null;
  classNote: number | null;
}

export interface TermGradeResult {
  /** Term total 0–100 = the sum of the four component marks. Components not yet
   *  entered count as 0. */
  total: number;
  /** True once every component has been entered. */
  complete: boolean;
  /** Letter grade derived from `total` via GRADE_BANDS. */
  grade: string;
}

/** The component maxima sum to exactly 100 (asserted at module load so a bad
 *  edit to GRADE_COMPONENTS fails loudly rather than silently mis-scaling). */
export const GRADE_TOTAL_MAX = GRADE_COMPONENTS.reduce((s, c) => s + c.max, 0);
if (GRADE_TOTAL_MAX !== 100) {
  throw new Error(`GRADE_COMPONENTS maxima must sum to 100, got ${GRADE_TOTAL_MAX}`);
}

/** The max mark for one component (used to validate teacher input at the API
 *  boundary and to bound the input in the UI). */
export function gradeComponentMax(key: GradeComponentKey): number {
  return GRADE_COMPONENTS.find((c) => c.key === key)?.max ?? 0;
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

/** A component mark clamped into [0, max]; null/blank counts as 0. */
function clampMark(v: number | null | undefined, max: number): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(max, v));
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
 * Pure term total for one subject: the SUM of the four component marks, each
 * bounded by its own maximum (exam 60 / midterm 20 / assignment 10 / note 10),
 * so the total is out of 100. Missing components count as 0 so a running total
 * is always meaningful; `complete` flags whether the teacher has entered all
 * four (i.e. whether the total is final).
 */
export function computeTermSubjectGrade(c: TermGradeComponents): TermGradeResult {
  const complete = GRADE_COMPONENTS.every((comp) => {
    const v = c[comp.key];
    return v !== null && v !== undefined;
  });
  const total = round2(
    GRADE_COMPONENTS.reduce((sum, comp) => sum + clampMark(c[comp.key], comp.max), 0),
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
  /** 1-based rank in THIS subject by total (ties share a position; null until
   *  the student has a total). */
  position: number | null;
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

/** One subject's cumulative line across the whole session: its total in each
 *  term (aligned to StudentSessionReportDto.terms order — null where not graded
 *  yet) plus the average of the terms that DO have a total. The last entry of
 *  `termTotals` is the final/third-term grade; `average` is the cumulative
 *  session grade for the subject. */
export interface SubjectSessionSummaryDto {
  subjectId: string;
  subjectName: string;
  termTotals: (number | null)[];
  average: number | null;
}

/** A whole session (first/second/third term) for one student. */
export interface StudentSessionReportDto {
  sessionId: string;
  sessionName: string;
  studentId: string;
  studentName: string;
  className: string | null;
  terms: StudentTermReportDto[];
  /** Per-subject cumulative summary across the session's terms (the two final
   *  categories: each subject's last-term total and its three-term average). */
  summary: SubjectSessionSummaryDto[];
  /** Overall session average = the mean of the per-term averages. */
  sessionAverage: number | null;
}

// ---------------------------------------------------------------------------
// Class broadsheet — the class supervisor's whole-class score sheet for a term:
// every student down the side, every subject across the top, each cell the
// subject total + grade, plus each student's average across subjects.
// ---------------------------------------------------------------------------

/** One subject cell for one student in the broadsheet (null total = not graded). */
export interface BroadsheetCellDto {
  subjectId: string;
  total: number | null;
  grade: string | null;
  /** DRAFT | PENDING_APPROVAL | PUBLISHED | "" (no row yet). */
  status: string;
}

/** One student's row across every subject, with their term average + position. */
export interface BroadsheetRowDto {
  studentId: string;
  studentName: string;
  admissionNumber: string | null;
  /** Aligned to ClassBroadsheetDto.subjects order. */
  cells: BroadsheetCellDto[];
  /** Average across the subjects that have a total (this term). */
  average: number | null;
  /** 1-based rank within the class by `average` (ties share a position). */
  position: number | null;
}

/** The supervisor/teacher view: one class, one term, all subjects × all students. */
export interface ClassBroadsheetDto {
  classId: string;
  className: string;
  sessionId: string;
  termId: string;
  termName: string;
  subjects: { id: string; name: string }[];
  rows: BroadsheetRowDto[];
}
