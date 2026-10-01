// =============================================================================
// Ledger integrity — invoices whose STATUS disagrees with their MONEY
// =============================================================================
// An invoice's status is a label derived from its payments (`invoiceStatusForNet`
// in the API). Nothing in the database enforces that, so a label can drift: a
// live database held an invoice marked PAID with ₦1,000 of ₦1,500 unpaid after a
// direct superuser DELETE removed the scholarship payment that had paid it. A
// PAID label stops reminders and reads as settled; an open label on a settled
// bill chases a family who has paid. This is how the platform finds both.
// =============================================================================

export const LEDGER_MISMATCH_KINDS = [
  /** Marked PAID; the ledger says money is still owed. Reminders have stopped. */
  "PAID_BUT_OWING",
  /** Marked ISSUED or PARTIALLY_PAID; the ledger says it is settled. The family
   *  may be chased for a bill they have paid. */
  "OPEN_BUT_SETTLED",
  /** ISSUED vs PARTIALLY_PAID the wrong way round — the label is wrong, the
   *  money owed is not in dispute. */
  "PARTIAL_MISLABELLED",
] as const;
export type LedgerMismatchKind = (typeof LEDGER_MISMATCH_KINDS)[number];

export const LEDGER_MISMATCH_LABELS: Record<LedgerMismatchKind, string> = {
  PAID_BUT_OWING: "Marked paid, still owed",
  OPEN_BUT_SETTLED: "Marked open, already settled",
  PARTIAL_MISLABELLED: "Part-paid label wrong",
};

export interface LedgerMismatchDto {
  invoiceId: string;
  schoolId: string;
  schoolName: string;
  reference: string;
  currency: string;
  totalMinor: number;
  /** POSTED payments minus POSTED refunds — the one definition of "paid". */
  netPaidMinor: number;
  status: string;
  /** What the ledger says the status should be. */
  derivedStatus: string;
  kind: LedgerMismatchKind;
  /** When the invoice row last changed — NOT when the money changed; a deleted
   *  payment leaves this untouched, which is exactly how a mismatch hides. */
  updatedAt: Date;
}

export interface LedgerMismatchPageDto {
  rows: LedgerMismatchDto[];
  /** Every mismatch on the platform, not just this page. */
  total: number;
  byKind: Record<LedgerMismatchKind, number>;
  /** Schools with at least one mismatch. */
  schools: number;
}

/** What one sweep found. `failed` is the jobs-console convention (always 0 —
 *  one fleet query either answers or throws, and a throw marks the run failed). */
export interface LedgerIntegrityResult {
  /** Billable invoices judged. */
  scanned: number;
  mismatched: number;
  paidButOwing: number;
  openButSettled: number;
  partialMislabelled: number;
  schools: number;
  failed: number;
}

/** The outcome of correcting one invoice's label. */
export interface LedgerRederiveResultDto {
  invoiceId: string;
  from: string;
  to: string;
  netPaidMinor: number;
  totalMinor: number;
  /** Finance staff at the school who were told. */
  notified: number;
}
