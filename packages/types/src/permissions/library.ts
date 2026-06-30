// Library Management — book catalogue, loans, fines.
export const LIBRARY_PERMISSIONS = {
  /** Search/view books and one's own loans. Every role in a school. */
  LIBRARY_READ: "library.read",
  /** Self-issue / renew a book (students). */
  LIBRARY_BORROW: "library.borrow",
  /** Manage the catalogue, issue/return for anyone, fines, reports, CSV. Librarian. */
  LIBRARY_MANAGE: "library.manage",
} as const;
export type LibraryPermission = (typeof LIBRARY_PERMISSIONS)[keyof typeof LIBRARY_PERMISSIONS];
