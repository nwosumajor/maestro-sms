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
  /** When true, students may attach a file as their answer. Teacher-controlled. */
  fileUploadEnabled: boolean;
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
  /** True when the student attached a file answer (downloadable for review). */
  hasFile: boolean;
  fileName: string | null;
}

/** Presigned URL result for a submission file upload/download. */
export interface SubmissionFilePresignDto {
  url: string;
  expiresInSeconds: number;
}


/**
 * An accessibility accommodation: integrity monitoring (paste-blocking, focus
 * tracking) is switched off for this pupil, globally or for one assessment.
 * `active` is derived — a revoked row is KEPT, never deleted, because an
 * accommodation record is evidence of a decision about a child.
 */
export interface IntegrityExemptionDto {
  id: string;
  studentId: string;
  studentName: string;
  /** Null = every assessment. */
  assessmentId: string | null;
  assessmentTitle: string | null;
  reason: string;
  grantedById: string;
  grantedByName: string;
  revokedAt: Date | null;
  revokedByName: string | null;
  active: boolean;
  createdAt: Date;
}
