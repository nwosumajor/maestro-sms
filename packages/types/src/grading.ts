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

export type GradeBand = { min: number; grade: string };

// =============================================================================
// Grade SCALES — what a school picks instead of typing boundaries
// =============================================================================
// The shape above is the whole safety argument, and it is worth stating because
// it is what makes this configurable at all: a band carries ONLY its floor. Each
// ceiling is implied by the next band down, the top band runs to 100 and the
// last runs to 0.
//
// That makes the two failure modes of a hand-typed scale UNREPRESENTABLE rather
// than merely validated:
//
//   gaps      A: 70-84, B: 60-68  ->  a mark of 69 maps to no grade at all
//   overlaps  A: 70-84, B: 65-75  ->  a mark of 72 is two different grades
//
// Neither can be expressed when there is nowhere to type a ceiling. A school
// that wants "A+ is 85 to 100" sets A+ = 85 and the 100 takes care of itself.
//
// Most schools should never reach even that: they pick a named scale. Adding one
// is a row here, the same posture as calendar templates, payroll packs and the
// subject catalogue.

export const GRADE_SCALES: Record<string, { label: string; note: string; bands: readonly GradeBand[] }> = {
  WAEC: {
    label: "WAEC / NECO (A–F, pass at 40)",
    note: "The West African standard: A1–F9 collapsed to letters, credit at 50, pass at 40.",
    bands: [
      { min: 75, grade: "A1" },
      { min: 70, grade: "B2" },
      { min: 65, grade: "B3" },
      { min: 60, grade: "C4" },
      { min: 55, grade: "C5" },
      { min: 50, grade: "C6" },
      { min: 45, grade: "D7" },
      { min: 40, grade: "E8" },
      { min: 0, grade: "F9" },
    ],
  },
  SIMPLE_LETTER: {
    label: "Simple letters (A–F, pass at 40)",
    note: "The platform default. A at 70, credit at 50, pass at 40.",
    bands: [
      { min: 70, grade: "A" },
      { min: 60, grade: "B" },
      { min: 50, grade: "C" },
      { min: 45, grade: "D" },
      { min: 40, grade: "E" },
      { min: 0, grade: "F" },
    ],
  },
  PLUS_MINUS: {
    label: "With plus grades (A+ from 85)",
    note: "A+ 85, A 70, B 60, C 50, D 45, E 40 — the scale in the example most schools describe.",
    bands: [
      { min: 85, grade: "A+" },
      { min: 70, grade: "A" },
      { min: 60, grade: "B" },
      { min: 50, grade: "C" },
      { min: 45, grade: "D" },
      { min: 40, grade: "E" },
      { min: 0, grade: "F" },
    ],
  },
  CAMBRIDGE: {
    label: "Cambridge / IGCSE style (A*–G)",
    note: "A* at 90, A at 80, then ten-point steps.",
    bands: [
      { min: 90, grade: "A*" },
      { min: 80, grade: "A" },
      { min: 70, grade: "B" },
      { min: 60, grade: "C" },
      { min: 50, grade: "D" },
      { min: 40, grade: "E" },
      { min: 30, grade: "F" },
      { min: 0, grade: "G" },
    ],
  },
  US_LETTER: {
    label: "United States (A–F, pass at 60)",
    note: "Ten-point scale; anything under 60 fails.",
    bands: [
      { min: 90, grade: "A" },
      { min: 80, grade: "B" },
      { min: 70, grade: "C" },
      { min: 60, grade: "D" },
      { min: 0, grade: "F" },
    ],
  },
};

export const DEFAULT_GRADE_SCALE = "SIMPLE_LETTER";

/**
 * Why a set of bands cannot be used. Null when it can.
 *
 * A CUSTOM scale still has to be checked, because a school may reorder or
 * duplicate the floors even though it cannot type a ceiling. Every rule here is
 * about a mark that would otherwise get the wrong grade or none.
 */
export function gradeScaleProblem(bands: readonly GradeBand[]): string | null {
  if (bands.length < 2) return "A scale needs at least two grades.";
  for (const b of bands) {
    if (!b.grade?.trim()) return "Every band needs a grade name.";
    if (!Number.isInteger(b.min) || b.min < 0 || b.min > 100) {
      return `"${b.grade}" starts at ${b.min}, which is not a whole number between 0 and 100.`;
    }
  }
  // Strictly descending: two bands sharing a floor makes the grade for that mark
  // depend on which row was read first.
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i].min >= bands[i - 1].min) {
      return `"${bands[i].grade}" starts at ${bands[i].min}, which is not below "${bands[i - 1].grade}" at ${bands[i - 1].min}. List them highest first.`;
    }
  }
  // The lowest band must reach 0, or the marks below it have no grade.
  if (bands[bands.length - 1].min !== 0) {
    return `The lowest grade must start at 0, or a mark below ${bands[bands.length - 1].min} would have no grade at all.`;
  }
  const names = bands.map((b) => b.grade.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two bands share a grade name.";
  return null;
}

/** The bands a school actually grades on: its own, else its named scale, else
 *  the platform default. Never returns an unusable set. */
export function resolveGradeBands(policy?: GradingPolicy | null): readonly GradeBand[] {
  if (policy?.bands && !gradeScaleProblem(policy.bands)) return policy.bands;
  const preset = GRADE_SCALES[policy?.scale ?? DEFAULT_GRADE_SCALE] ?? GRADE_SCALES[DEFAULT_GRADE_SCALE];
  return preset.bands;
}

/** A component mark clamped into [0, max]; null/blank counts as 0. */
function clampMark(v: number | null | undefined, max: number): number {
  if (v === null || v === undefined || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function gradeLetter(total: number, bands?: readonly GradeBand[]): string {
  for (const band of bands ?? GRADE_BANDS) {
    if (total >= band.min) return band.grade;
  }
  // Only reachable if a caller passes bands whose lowest floor is above 0 —
  // gradeScaleProblem refuses those, so this is a belt-and-braces last resort.
  return (bands ?? GRADE_BANDS)[(bands ?? GRADE_BANDS).length - 1]?.grade ?? "F";
}

/**
 * Pure term total for one subject: the SUM of the four component marks, each
 * bounded by its own maximum (exam 60 / midterm 20 / assignment 10 / note 10),
 * so the total is out of 100. Missing components count as 0 so a running total
 * is always meaningful; `complete` flags whether the teacher has entered all
 * four (i.e. whether the total is final).
 */
export function computeTermSubjectGrade(
  c: TermGradeComponents,
  /** The school's weighting. Defaults to the platform's, so every existing caller
   *  and every school already live is unchanged. */
  components: ReadonlyArray<{ key: GradeComponentKey; max: number }> = GRADE_COMPONENTS,
  /** The school's letter scale. Defaults to the platform's, so every existing
   *  caller and every school already live is unchanged. */
  bands?: readonly GradeBand[],
): TermGradeResult {
  const complete = components.every((comp) => {
    const v = c[comp.key];
    return v !== null && v !== undefined;
  });
  const total = round2(components.reduce((sum, comp) => sum + clampMark(c[comp.key], comp.max), 0));
  return { total, complete, grade: gradeLetter(total, bands) };
}

// =============================================================================
// Per-school grading weighting
// =============================================================================
// 60/20/10/10 is one country's convention. An IB, A-Level or GPA school weights
// coursework and examination differently, and until now could not say so.
//
// The COMPONENTS are fixed (exam, midterm, assignment, class note) — changing
// those would change what a teacher is asked to enter, and every stored mark. Only
// their WEIGHTS move, and they must still total 100 so a term mark remains
// comparable across schools and across years.
// =============================================================================

/** A school's weighting: the same four components, different maxima. */
export interface GradingPolicy {
  components: ReadonlyArray<{ key: GradeComponentKey; label: string; max: number }>;
  /** A key of GRADE_SCALES. What almost every school should set. */
  scale?: string;
  /** A hand-built scale, floors only. Overrides `scale` when valid. */
  bands?: readonly GradeBand[];
}

export const DEFAULT_GRADING_POLICY: GradingPolicy = { components: GRADE_COMPONENTS };

/** Named starting points a school can pick rather than typing four numbers. */
export const GRADING_PRESETS: Record<string, { label: string; weights: Record<GradeComponentKey, number> }> = {
  EXAM_HEAVY: { label: "Exam-weighted (60/20/10/10)", weights: { exam: 60, midterm: 20, assignment: 10, classNote: 10 } },
  BALANCED: { label: "Balanced (50/20/20/10)", weights: { exam: 50, midterm: 20, assignment: 20, classNote: 10 } },
  COURSEWORK_HEAVY: { label: "Coursework-weighted (40/20/30/10)", weights: { exam: 40, midterm: 20, assignment: 30, classNote: 10 } },
};

/**
 * Build a policy from stored weights, falling back to the platform default.
 *
 * REFUSES a weighting that does not total 100 — silently rescaling would make one
 * school's 72% mean something different from another's, which is exactly the kind
 * of quiet divergence that ends up in a transcript.
 */
export function resolveGradingPolicy(stored: unknown): GradingPolicy {
  const raw = stored as {
    weights?: Partial<Record<GradeComponentKey, number>>;
    scale?: string;
    bands?: GradeBand[];
  } | null;
  // The letter SCALE is independent of the weights: a school may keep the
  // default 60/20/10/10 and still want A+ from 85. Reading them separately means
  // choosing one never silently resets the other.
  const scalePart = {
    ...(raw?.scale ? { scale: raw.scale } : {}),
    ...(raw?.bands && !gradeScaleProblem(raw.bands) ? { bands: raw.bands } : {}),
  };
  const w = raw?.weights;
  if (!w) return { ...DEFAULT_GRADING_POLICY, ...scalePart };
  const components = GRADE_COMPONENTS.map((c) => ({
    key: c.key,
    label: c.label,
    max: typeof w[c.key] === "number" && w[c.key]! >= 0 ? Math.round(w[c.key]!) : c.max,
  }));
  const total = components.reduce((s, c) => s + c.max, 0);
  return total === 100 ? { components, ...scalePart } : { ...DEFAULT_GRADING_POLICY, ...scalePart };
}

/** Do these weights form a usable policy? Used at the API boundary so a bad
 *  weighting is refused loudly rather than silently ignored on read. */
export function isValidGradingWeights(w: Partial<Record<GradeComponentKey, number>>): boolean {
  const total = GRADE_COMPONENTS.reduce((s, c) => s + (typeof w[c.key] === "number" ? Math.round(w[c.key]!) : c.max), 0);
  return total === 100 && GRADE_COMPONENTS.every((c) => (w[c.key] ?? c.max) >= 0);
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
  /** Are ALL of the school's components marked?
   *
   *  A missing component counts as ZERO in the total, so a pupil whose exam has
   *  not been entered yet reads as a fail rather than as unmarked. The
   *  computation always knew this and returned it; every consumer discarded it,
   *  so an interim mark was indistinguishable from a final one — on the
   *  approver's screen and on the report card that reaches the family. */
  complete: boolean;
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
  /** Are all of the school's components marked? A missing one counts as ZERO in
   *  the total, so without this a report card cannot tell a pupil who scored 24
   *  from one whose exam has simply not been marked yet. */
  complete: boolean;
  /**
   * This student's rank in THIS subject among classmates, and how many were
   * ranked. Null when they have no total for it — an ungraded pupil is unranked
   * rather than last.
   *
   * Standard competition ranking: ties share a position and the next rank skips
   * (68, 68, 65 -> 1st, 1st, 3rd). Two pupils on the same mark being told they
   * are 1st and 2nd is the thing that makes a parent write in.
   *
   * Discloses only THIS pupil's standing — a number about them, never another
   * child's marks or name. Same posture as the overall class position already
   * printed on the card.
   */
  subjectPosition: number | null;
  subjectRanked: number | null;
}

/** One term's worth of subject rows + the term average. */
export interface StudentTermReportDto {
  termId: string;
  termName: string;
  sequence: number;
  subjects: TermSubjectRowDto[];
  /**
   * Subjects the pupil takes whose marks are NOT released yet — names only, no
   * figures.
   *
   * A family view shows published results only, which is right. But an
   * unreleased subject used to disappear from the report altogether, and a pupil
   * looking at eight of their nine subjects could not tell whether the ninth was
   * still being marked, was held at head-teacher review, or was simply not one
   * of theirs. Saying the name — and nothing else — answers that without
   * releasing a provisional mark. Always empty for staff, who see every row.
   */
  awaitingRelease: string[];
  average: number | null;
  /** The letter for `average`, on the SCHOOL's scale.
   *
   *  Carried rather than recomputed by each consumer. The report card used to
   *  derive it locally with `gradeLetter(average)` and no bands, so a school
   *  with its own scale printed subject grades on that scale and the overall
   *  grade underneath them on the platform default — two scales on one page a
   *  family reads. */
  averageGrade: string | null;
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

/**
 * What happened at stage 1 of a subject selection.
 *
 * SKIPPED_NO_SUPERVISOR is the one worth naming. A class with no supervisor
 * sends the selection straight to PENDING_ADMIN — a deliberate fail-open, so a
 * pupil is never stranded by an unconfigured class. But the reviewer at stage 2
 * then IS the only check, and nothing said so: `PENDING_ADMIN` looks identical
 * whether a form teacher passed it or whether there was never a form teacher.
 * A control that quietly becomes one stage reads as two.
 */
export type SupervisorStage = "PENDING" | "PASSED" | "SKIPPED_NO_SUPERVISOR";

/** Derived from the row, never stored — one source of truth for the answer. */
export function supervisorStage(row: {
  status: string;
  supervisorId: string | null;
  supervisorActedById: string | null;
}): SupervisorStage {
  if (row.status === "PENDING_SUPERVISOR") return "PENDING";
  // No supervisor was ever named on the class, so stage 1 did not run.
  if (!row.supervisorId) return "SKIPPED_NO_SUPERVISOR";
  // Named but never acted: the class supervisor changed after submission, so
  // the stage the row moved past is not one anybody actually performed.
  return row.supervisorActedById ? "PASSED" : "SKIPPED_NO_SUPERVISOR";
}

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
  /** What actually happened at stage 1 — see `supervisorStage`. DERIVED, never
   *  stored, so it cannot drift from the row it describes. */
  supervisorStage: SupervisorStage;
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
  /**
   * The SCHOOL's weighting and letter scale, carried on the roster itself.
   *
   * The console previews each total in the browser as the teacher types. It used
   * to preview with the platform defaults while the server saved with the
   * school's policy, so on any school that had set its own weights the number
   * the teacher watched was not the number that got stored. Sending the policy
   * with the roster means the preview cannot drift from the save: there is no
   * second source to fall out of step with.
   */
  components: { key: GradeComponentKey; label: string; max: number }[];
  bands: GradeBand[];
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
  /** Every component marked? An unmarked one counts as zero, so a provisional
   *  total is a real number that reads like a poor result. */
  complete: boolean;
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

// -----------------------------------------------------------------------------
// What a cumulative session average actually covers
// -----------------------------------------------------------------------------
// The session average is computed over terms that HAVE marks, which is correct
// arithmetic — averaging in a term with no data would drag every mid-year
// school's figures toward nothing. But the report card labelled it "all terms so
// far", and for a school that onboarded in Term 2 that is false: the number
// covers 2 of 3 terms and reads as a full year.
//
// So the label states the coverage. A parent can then see that the figure is
// partial without having to know when the school joined the platform.
export function sessionAverageScope(counted: number, total: number): string {
  return total > 0 && counted < total ? `${counted} of ${total} terms recorded` : `all ${counted} terms`;
}

// -----------------------------------------------------------------------------
// Subject performance analytics — one row per class-subject
// -----------------------------------------------------------------------------
// The question a teacher actually asks after entering marks is not "what did
// each pupil get" (the roster answers that) but "how did the class do, and where
// did they lose it". So the row carries the COMPONENT averages alongside the
// overall one: a class averaging 58 with an exam mean of 31/60 and an assignment
// mean of 9/10 has an exam problem, not a coursework problem, and that is
// actionable in a way a single number is not.
//
// `published` is reported next to `entered` on purpose. Staff analytics counts
// marks that are still DRAFT — refusing to show a teacher their own unpublished
// class average would make the view useless exactly when it is most wanted,
// before results go out — but a reader deserves to know how firm the figure is.
export interface SubjectAnalyticsRowDto {
  classId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  /** Marks recorded for this class-subject in the term (any status). */
  entered: number;
  /** How many of those are PUBLISHED — the rest are still provisional. */
  published: number;
  /** Weighted total, averaged. Null when nothing is recorded yet. */
  averageTotal: number | null;
  highest: number | null;
  lowest: number | null;
  /** Component averages, each on ITS OWN scale (exam /60, midterm /20, …). */
  components: {
    exam: number | null;
    midterm: number | null;
    assignment: number | null;
    classNote: number | null;
  };
  /** Distribution over the SCHOOL'S OWN grade scale, in its own order. */
  bands: Array<{ grade: string; count: number }>;
}

export interface SubjectAnalyticsDto {
  termId: string;
  /**
   * "school" — every class-subject in the school (leadership).
   * "teaching" — only the class-subjects this caller teaches.
   * Stated in the payload so a screen can say which it is showing rather than
   * leaving a teacher to wonder whether the school really has three subjects.
   */
  scope: "school" | "teaching";
  rows: SubjectAnalyticsRowDto[];
}
