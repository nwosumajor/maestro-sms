// Library Management response DTOs (server form; Date fields are Date).

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
}

/** Fine receipt issued when an overdue fine is paid. */
export interface FineReceiptDto {
  loanId: string;
  bookTitle: string;
  borrowerName: string;
  fineMinor: number;
  paidAt: Date;
  reference: string;
}
