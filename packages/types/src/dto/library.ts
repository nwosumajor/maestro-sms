// Library Management response DTOs (server form; Date fields are Date).

/**
 * The two states a loan can be in.
 *
 * Exported so the list endpoint can REFUSE anything else. It used to pass the
 * caller's string straight into the query, so `?status=OUT` — a plausible guess
 * — matched nothing and the page reported that the school has no books on loan.
 * A filter nobody validated is a filter that answers a question nobody asked.
 */
export const BOOK_LOAN_STATUSES = ["ISSUED", "RETURNED"] as const;
export type BookLoanStatus = (typeof BOOK_LOAN_STATUSES)[number];


/** A page of the catalogue. */
export interface LibraryBookPageDto {
  items: LibraryBookDto[];
  /** Titles held in all. The list was capped at 200 and said so nowhere. */
  total: number;
  page: number;
  pageSize: number;
}

export interface LibraryBookDto {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  barcode: string;
  category: string | null;
  totalCopies: number;
  availableCopies: number;
  customFields: Record<string, string>;
  createdAt: Date;
}

export interface BookLoanDto {
  id: string;
  bookId: string;
  bookTitle: string;
  barcode: string;
  borrowerId: string;
  borrowerName: string;
  status: string;
  issuedAt: Date;
  dueAt: Date;
  returnedAt: Date | null;
  renewedCount: number;
  fineMinor: number;
  finePaid: boolean;
  /** True if currently issued and past due. */
  overdue: boolean;
}

/**
 * A page of loans.
 *
 * The list used to be a bare array capped at the 300 most recent. A library is
 * a LEDGER, not a queue: at three years a secondary holds ~12,000 loans, and an
 * OVERDUE loan is by definition an OLD one — so newest-first threw away exactly
 * the rows the lending desk exists to chase. Measured on a 1,200-pupil school:
 * 1,316 overdue, 14 of them reachable, under a strip that counted all 1,316 in
 * SQL and printed the number.
 */
export interface BookLoanPageDto {
  items: BookLoanDto[];
  /** Matching the filter, in the school — NOT the length of `items`. */
  total: number;
  page: number;
  pageSize: number;
}

/** Librarian report over a window: counts + fine totals. */
export interface LibraryReportDto {
  issued: number;
  returned: number;
  overdue: number;
  finesAccruedMinor: number;
  finesCollectedMinor: number;
  totalTitles: number;
  totalCopies: number;
  availableCopies: number;
  /**
   * The currency the fine figures are in — the SCHOOL's, which is where the
   * fine is charged (`effectiveLibraryFinePerDayMinor` reads `school.currency`).
   * It was absent, so the page had nothing to format with and fell back to the
   * platform's: a Ghanaian school's screen read "Fines accrued ₦300,000.00"
   * directly above a loan table printing the same fines as GH₵200.00.
   */
  currency: string;
}

/** Fine receipt issued when an overdue fine is paid. */
export interface FineReceiptDto {
  loanId: string;
  bookTitle: string;
  borrowerName: string;
  fineMinor: number;
  /** When the money was taken. NULL only on rows paid before this was recorded
   *  and whose return date is also unknown — an absent date is visibly absent,
   *  an invented one is not. */
  paidAt: Date | null;
  reference: string;
}

/**
 * Somebody a librarian can issue a book to.
 *
 * The lending desk's OWN lookup, deliberately narrow. `issue` has always
 * supported "librarians to anyone, students to themselves" and the only control
 * was "Issue to me", so a librarian could not lend a book to a pupil through the
 * product at all — the module's central act. The existing people picker needs
 * `class.write` (create classes, enrol pupils, assign teachers), which is not a
 * permission a librarian should hold to look up a borrower, so this exposes
 * strictly less than that route rather than widening it: no email, no roles, no
 * contact details.
 *
 * `admissionNo` is here because two pupils sharing a name is ordinary, and
 * picking the wrong one puts a book on the wrong child's record.
 */
export interface LibraryBorrowerDto {
  id: string;
  name: string;
  admissionNo: string | null;
  /** "Student" or "Staff" — enough to tell a pupil from a teacher, no more. */
  kind: "STUDENT" | "STAFF";
}
