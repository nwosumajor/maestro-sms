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
  /**
   * MAY THIS READER WRITE IT — answered by the server, which is the only side
   * that can.
   *
   * This is the CLASS TEACHER's to write, and the web decided from the role
   * permission alone (`grade.write`), which every subject teacher holds. So it
   * was offered to eleven people per class and accepted from one. A control
   * that is offered and then refused is the mirror of the defect this repo
   * records the other way round — gating a route whose UI still calls it.
   *
   * Supervision is per-pupil and cannot be read off a session, so it rides the
   * DTO the editor already fetches rather than costing a second round trip.
   */
  mayWriteClassTeacherRemark: boolean;
}
