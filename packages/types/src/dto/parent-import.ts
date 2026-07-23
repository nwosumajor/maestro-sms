// Parent onboarding — single create + bulk upload (maker-checker) DTOs.
// A parent gets a generated one-time password (forced reset at first login,
// exactly like the SIS student import) and is linked to their children, who are
// referenced by admission number and/or email (in-tenant).

/** One row of the parent-import template (parsed from CSV client-side). */
export interface ParentImportRow {
  name: string;
  /**
   * The guardian's REAL, deliverable address — stored as `contactEmail`. Their
   * sign-in identifier is GENERATED (firstname.lastname@<slug>.com), so this is
   * never the login. Required: a guardian with no reachable address can never
   * get a password reset or a receipt.
   */
  contactEmail: string;
  phone?: string | null;
  /** Children by admission number, ";"-separated (e.g. "ADM-001;ADM-014"). */
  studentAdmissionNumbers?: string | null;
  /** Children by student email, ";"-separated. Merged with the admission numbers. */
  studentEmails?: string | null;
  /** Optional relationship label stamped on each link (e.g. "Mother"). */
  relationship?: string | null;
}

export interface ParentImportSummary {
  total: number;
  /** Emails not already in use (a parent account will be created on approval). */
  newCount: number;
  /** Emails already present (the existing account is reused, not recreated). */
  duplicateCount: number;
  /** Populated after approval. */
  created?: number;
  /** Existing accounts reused (linked without a new account/credential). */
  reused?: number;
  /** ParentChild links created across all rows. */
  linked?: number;
  /** Referenced students that could not be found in the school. */
  unmatchedStudents?: number;
  errors?: number;
}

/** One created account's one-time credential (shown ONCE, never persisted). */
export interface ParentCredential {
  name: string;
  email: string;
  tempPassword: string;
}

export interface ParentImportBatchDto {
  id: string;
  status: string;
  uploadedById: string;
  reviewedById: string | null;
  rowCount: number;
  summary: ParentImportSummary | null;
  reviewNote: string | null;
  createdAt: Date;
  /** ONLY on the approve response: each NEWLY created parent's temp password. */
  credentials?: ParentCredential[];
}

/** Single-parent onboarding result: the account + which children were linked. */
export interface CreateParentResultDto {
  parentId: string;
  name: string;
  email: string;
  /** Present only when a NEW account was created (else the account existed). */
  tempPassword: string | null;
  created: boolean;
  linkedStudentIds: string[];
}
