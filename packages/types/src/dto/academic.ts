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

/** A non-teaching day / holiday span (single-day when start === end). */
export interface SchoolHolidayDto {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
}

/** A student's report-card narrative remarks for one term. */
export interface ReportCardRemarkDto {
  studentId: string;
  termId: string;
  classTeacherRemark: string | null;
  headRemark: string | null;
  /**
   * WHO wrote each remark. The ids have been stored since this table was
   * created and every reader dropped them, so a screen could show a comment
   * about a child with nobody's name against it — the same gap the printed card
   * had. A judgement about a pupil is answerable or it is not a judgement.
   * Null when the author's account is gone; the remark itself still stands.
   */
  classTeacherName: string | null;
  headName: string | null;
  updatedAt: Date | null;
}
