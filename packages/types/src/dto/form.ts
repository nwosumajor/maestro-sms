// Form Builder response DTOs (server form; Date fields are Date).

export interface FormFieldDef {
  key: string;
  label: string;
  type: string; // text | textarea | number | select | rating
  options?: string[];
  required?: boolean;
}

export interface FormDto {
  id: string;
  title: string;
  description: string | null;
  fields: FormFieldDef[];
  audience: string;
  anonymous: boolean;
  status: string;
  createdByName: string;
  responseCount: number;
  /** Whether the caller has already responded. */
  hasResponded: boolean;
  createdAt: Date;
}

/** One submitted response (respondent is null for anonymous forms). */
export interface FormResponseDto {
  id: string;
  respondentName: string | null;
  answers: Record<string, string | number>;
  createdAt: Date;
}
