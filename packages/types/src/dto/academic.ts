// Academic calendar (sessions + terms) DTOs.

export interface TermDto {
  id: string;
  sessionId: string;
  name: string;
  sequence: number;
  isCurrent: boolean;
  startDate: Date | null;
  endDate: Date | null;
}

export interface AcademicSessionDto {
  id: string;
  name: string;
  isCurrent: boolean;
  startDate: Date | null;
  endDate: Date | null;
  terms: TermDto[];
}

/** A student's report-card narrative remarks for one term. */
export interface ReportCardRemarkDto {
  studentId: string;
  termId: string;
  classTeacherRemark: string | null;
  headRemark: string | null;
  updatedAt: Date | null;
}
