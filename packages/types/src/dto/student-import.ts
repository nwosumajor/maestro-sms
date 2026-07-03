// Bulk SIS student-import (maker-checker) DTOs.

/** One row of the SIS import template (parsed from CSV client-side). */
export interface StudentImportRow {
  name: string;
  email: string;
  admissionNumber?: string | null;
  dateOfBirth?: string | null; // YYYY-MM-DD
  gender?: string | null;
  phone?: string | null;
  address?: string | null;
  /** Optional class to enroll the new student into on approval. */
  classId?: string | null;
}

/** Dry-run / result summary for a batch. */
export interface StudentImportSummary {
  total: number;
  /** Emails not already in use (will be created on approval). */
  newCount: number;
  /** Emails already present (skipped on approval). */
  duplicateCount: number;
  /** Populated after approval. */
  created?: number;
  skipped?: number;
  errors?: number;
}

export interface StudentImportBatchDto {
  id: string;
  status: string;
  uploadedById: string;
  reviewedById: string | null;
  rowCount: number;
  summary: StudentImportSummary | null;
  reviewNote: string | null;
  createdAt: Date;
  /** ONLY on the approve response: each newly created student's one-time
   *  temporary password (never persisted; the student must change it at first
   *  login). Download/print immediately — it cannot be retrieved again. */
  credentials?: { name: string; email: string; tempPassword: string }[];
}
