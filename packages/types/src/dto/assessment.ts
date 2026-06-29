// Assessment list + submissions response DTOs (Assessment Integrity module).

export interface AssessmentSummaryDto {
  id: string;
  title: string;
  description: string | null;
  classId: string | null;
  className: string | null;
  createdById: string;
  /** True when the caller created it (teacher view affordances). */
  mine: boolean;
  integrityEnabled: boolean;
  /** Teacher/staff view: number of submissions. */
  submissionCount: number;
  /** Student view: the caller's own submission status (null if not started / staff). */
  mySubmissionStatus: string | null;
  createdAt: Date;
}

export interface AssessmentSubmissionDto {
  id: string;
  studentId: string;
  studentName: string | null;
  status: string;
  submittedAt: Date | null;
  /** Count of integrity signals raised (drives the teacher's review priority). */
  signalCount: number;
}
