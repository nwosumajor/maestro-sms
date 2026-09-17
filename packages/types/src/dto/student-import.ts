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
  /** Still accepted so a file somebody already built keeps working; mapped onto
   *  `addressLine1`, which is what the profile and the completion rule call it. */
  address?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  /**
   * `city` and `state` are in `SIS_REQUIRED_PROFILE_FIELDS` — a profile is not
   * COMPLETE without them. The template had no column for either, so a school
   * importing an accurate register still had every pupil nudged nightly for two
   * fields it was never given anywhere to type.
   */
  city?: string | null;
  state?: string | null;
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
  /**
   * Rows that MATCH a pupil already on roll, by admission number, and would
   * update that pupil's record on approval.
   *
   * The import used to be create-only: a matching row was counted as a
   * "duplicate" and silently dropped. That made the file a one-shot — there was
   * no bulk route to correct a typo, fill in the columns a school did not have
   * on the day, or load the address details it gathered later, so a school that
   * got its first import slightly wrong faced fixing it one pupil at a time for
   * ever.
   *
   * An update is a real change to a pupil's record, so it goes through the SAME
   * maker-checker approval a creation does — and the reviewer is shown the
   * FIELDS that would change, per pupil, before deciding. A count alone would
   * ask somebody to approve something they cannot see.
   */
  updateCount?: number;
  /** Per-pupil preview of what an update would change. Capped for the screen;
   *  `updateCount` is the true total. */
  updates?: StudentImportUpdatePreview[];
  /** Populated after approval. */
  created?: number;
  /** Existing pupils whose record was updated. */
  updated?: number;
  skipped?: number;
  errors?: number;
}

/** One pupil an approval would change, and what would change on them. */
export interface StudentImportUpdatePreview {
  admissionNumber: string;
  name: string;
  /** field -> what it would become. Only fields that actually differ. */
  changes: { field: string; from: string | null; to: string | null }[];
}

/** How many update previews ride on the summary. The rest are counted, never
 *  listed — a reviewer reads a sample and a total, not five hundred rows. */
export const STUDENT_IMPORT_UPDATE_PREVIEW = 25;

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
