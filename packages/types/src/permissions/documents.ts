// =============================================================================
// Document Vault — permission constants (single source of truth)
// =============================================================================
// Coarse permissions gate the ENDPOINTS; relationship scoping (student -> own,
// guardian -> their children, teacher -> their students, staff/board -> all)
// narrows the ROWS in DocumentsService, backstopped by RLS. Bytes live in S3/R2;
// the API only ever hands out PRESIGNED URLs, never the file itself.
// =============================================================================

export const DOCUMENT_TYPES = [
  "REPORT_CARD",
  "RECEIPT",
  "CERTIFICATE",
  "TRANSCRIPT",
  "OTHER",
] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_PERMISSIONS = {
  /** Read metadata + obtain a presigned download URL (rows scoped). */
  DOCUMENT_READ: "document.read",
  /** Upload (create + confirm) and delete documents. Staff. */
  DOCUMENT_WRITE: "document.write",
} as const;

export type DocumentPermission =
  (typeof DOCUMENT_PERMISSIONS)[keyof typeof DOCUMENT_PERMISSIONS];

/** Suggested role -> permission additions (spread into the foundation mapping). */
export const DOCUMENT_ROLE_PERMISSIONS = {
  principal: [DOCUMENT_PERMISSIONS.DOCUMENT_READ, DOCUMENT_PERMISSIONS.DOCUMENT_WRITE],
  school_admin: [DOCUMENT_PERMISSIONS.DOCUMENT_READ, DOCUMENT_PERMISSIONS.DOCUMENT_WRITE],
  teacher: [DOCUMENT_PERMISSIONS.DOCUMENT_READ, DOCUMENT_PERMISSIONS.DOCUMENT_WRITE],
  accountant: [DOCUMENT_PERMISSIONS.DOCUMENT_READ, DOCUMENT_PERMISSIONS.DOCUMENT_WRITE],
  board: [DOCUMENT_PERMISSIONS.DOCUMENT_READ],
  parent: [DOCUMENT_PERMISSIONS.DOCUMENT_READ],
  student: [DOCUMENT_PERMISSIONS.DOCUMENT_READ],
} as const;
