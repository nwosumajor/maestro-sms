// Privacy (NDPR right-to-erasure) response DTOs.

export interface ErasureRequestDto {
  id: string;
  studentId: string;
  reason: string;
  status: string;
  createdAt: Date;
  /** When an answer is due, from the school's regime. */
  dueAt: Date;
  /** Days left to answer; null once the request has been decided. */
  daysRemaining: number | null;
  /** Still open and past its date. */
  overdue: boolean;
  /**
   * Whether that date is the LAW or a good-practice target.
   *
   * The screen must word the two differently. A period this platform has not
   * recorded for the school's regime falls back to a default, and showing it as
   * a statutory deadline would invent one.
   */
  deadlineIsStatutory: boolean;
  targetDays: number;
}
