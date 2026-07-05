// Parent portal — the consolidated per-child overview. Everything here is
// scoped through ParentChild (a parent only ever receives their OWN children)
// and contains only guardian-appropriate information: published grades,
// attendance counts, discipline complaints ABOUT the child, assigned tasks,
// and the family's outstanding fees. No drafts, no raw integrity telemetry.

export interface ChildAttendanceSummaryDto {
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  /** Present+late as a % of taken registers (null when nothing taken yet). */
  pct: number | null;
}

export interface ChildGradesSummaryDto {
  sessionId: string;
  sessionName: string;
  /** Average of PUBLISHED weighted totals per term, in term order. */
  termAverages: { termId: string; termName: string; average: number | null }[];
  sessionAverage: number | null;
}

export interface ChildDisciplineItemDto {
  id: string;
  subject: string;
  status: string;
  createdAt: Date;
}

export interface ChildTaskItemDto {
  id: string;
  title: string;
  /** The child's own assignment status (ASSIGNED | IN_PROGRESS | DONE …). */
  assignmentStatus: string;
  dueAt: Date | null;
}

export interface ChildOverviewDto {
  studentId: string;
  studentName: string;
  className: string | null;
  attendance: ChildAttendanceSummaryDto;
  /** Null until the school has a current session / published results. */
  grades: ChildGradesSummaryDto | null;
  discipline: ChildDisciplineItemDto[];
  tasks: ChildTaskItemDto[];
  fees: { outstandingMinor: number; unpaidInvoices: number };
}

export interface FamilyOverviewDto {
  children: ChildOverviewDto[];
}
