// Document Vault response DTOs.

export interface DocumentRowDto {
  id: string;
  type: string;
  title: string;
  status: string;
  createdAt: Date;
}

/** A page of documents plus the cursor for the next one (null = end of list). */
export interface DocumentPageDto {
  items: DocumentRowDto[];
  nextCursor: string | null;
}

// --- supplied documents (what a school asks a family or a candidate for) -----

export interface DocumentRequirementDto {
  id: string;
  appliesTo: string;
  key: string;
  label: string;
  description: string | null;
  mandatory: boolean;
  needsExpiry: boolean;
  sequence: number;
  active: boolean;
}

export interface DocumentSubmissionDto {
  id: string;
  requirementId: string | null;
  /** The requirement's label at read time — a school may reword it, and the row
   *  should read as what is asked for NOW, not what was asked then. */
  requirementLabel: string | null;
  originalName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  status: string;
  /** Null when a parent or candidate uploaded it — they have no account. */
  uploadedByUserId: string | null;
  uploadedAt: Date | null;
  verifiedById: string | null;
  verifiedByName: string | null;
  verifiedAt: Date | null;
  rejectedReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Everything one screen needs about one person's paperwork: what is asked for,
 *  what arrived, and the single number worth chasing. */
export interface SubmissionChecklistDto {
  subjectKind: string;
  subjectId: string;
  requirements: DocumentRequirementDto[];
  submissions: DocumentSubmissionDto[];
  outstanding: DocumentRequirementDto[];
  progress: { required: number; satisfied: number; missingMandatory: number; complete: boolean };
}

/** A presigned PUT for the browser, plus the row it will be confirmed against. */
export interface UploadTicketDto {
  submissionId: string;
  uploadUrl: string;
  expiresInSeconds: number;
  maxBytes: number;
}
