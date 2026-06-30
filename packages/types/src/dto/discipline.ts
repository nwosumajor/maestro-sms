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
