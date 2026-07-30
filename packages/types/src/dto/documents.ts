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
