import type { IdNameDto } from "./common";
// Discipline Room response DTOs (server form; Date fields are Date).

export interface DisciplineAssigneeDto {
  id: string;
  assigneeId: string;
  assigneeName: string;
}

export interface DisciplineEvidenceDto {
  id: string;
  uploadedById: string;
  uploadedByName: string;
  fileName: string;
  createdAt: Date;
}

export interface DisciplineEntryDto {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface DisciplineComplaintDto {
  id: string;
  subject: string;
  details: string | null;
  complainantId: string;
  complainantName: string;
  againstId: string;
  againstName: string;
  againstType: string;
  status: string;
  resolution: string | null;
  assignees: DisciplineAssigneeDto[];
  evidence: DisciplineEvidenceDto[];
  entries: DisciplineEntryDto[];
  createdAt: Date;
}

/** Presigned upload URL for evidence. */
export interface DisciplineEvidencePresignDto {
  url: string;
  key: string;
}

/**
 * The people this caller may file a complaint AGAINST.
 *
 * It was a bare array capped at 500 by name with no search and no count. On a
 * 1,200-pupil roll that returned A to K: **690 pupils could not be named in a
 * complaint at all**, and the screen gave no sign — the dropdown simply did not
 * contain them. A concern that cannot be filed is a concern that goes
 * unrecorded, which on a safeguarding path is the whole point of the feature.
 */
export interface FileTargetsDto {
  items: IdNameDto[];
  /** How many the caller may file against in all — not how many fit the cap. */
  total: number;
  /**
   * Whether the caller's set is large enough to need searching. A pupil's own
   * classmates are bounded by the class and arrive whole; a manager's set is
   * the school and does not.
   */
  searchable: boolean;
}
