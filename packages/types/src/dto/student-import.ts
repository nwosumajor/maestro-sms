// Bulk SIS student-import (maker-checker) DTOs.

/** One row of the SIS import template (parsed from CSV client-side). */
export interface StudentImportRow {
  name: string;
  /**
   * OPTIONAL. Omit it and a sign-in identifier is generated from the name and
   * the school's domain (firstname.lastname@<slug>.com) — most pupils have no
   * address of their own, so requiring one made schools invent fake ones.
   */
  email?: string | null;
  admissionNumber?: string | null;
  dateOfBirth?: string | null; // YYYY-MM-DD
  gender?: string | null;
  phone?: string | null;
  address?: string | null;
  /**
   * Optional class to enrol into on approval, written the way the SCHOOL
   * writes it: the class NAME ("SS3 Science A") or its CODE. Both are unique
   * per school and both are on the classes page.
   *
   * This replaced a raw `classId` uuid, which nobody has: filling in a
   * spreadsheet meant digging an id out of a URL for every class, pasting it
   * once per pupil, and then being unable to check the file because a column
   * of uuids cannot be read back.
   */
  class?: string | null;
  /** Still accepted so a file somebody already built keeps working. */
  classId?: string | null;
}

/** Dry-run / result summary for a batch. */
export interface StudentImportSummary {
  total: number;
  /** Rows that will create a new student on approval. */
  newCount: number;
  /** Rows whose sign-in identifier is already taken (skipped on approval). */
  duplicateCount: number;
  /**
   * Class values in the file that matched no class. Reported by the DRY RUN,
   * before anything is created — a misspelt class name would otherwise enrol
   * the pupil nowhere and say nothing, which is the failure this whole review
   * keeps finding.
   */
  unknownClasses?: string[];
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
  credentials?: { name: string; email: string; tempPassword: string; admissionNumber: string }[];
}
