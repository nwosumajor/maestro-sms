// Role-scoped analytics overview response DTO.

export interface AnalyticsOverviewDto {
  scope: "school" | "family";
  attendance?: {
    PRESENT: number;
    ABSENT: number;
    LATE: number;
    EXCUSED: number;
    total: number;
    ratePct: number | null;
  };
  fees?: { invoicedMinor: number; collectedMinor: number; outstandingMinor: number; invoices: number };
  operations?: {
    students?: number;
    classes?: number;
    pendingApprovals?: number;
    integritySignals?: number;
  };
}
