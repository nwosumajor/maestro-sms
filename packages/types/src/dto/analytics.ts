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
  /** Published-grade distribution by band (A≥70 · B 60–69 · C 50–59 · D 45–49 · F<45). */
  grades?: { A: number; B: number; C: number; D: number; F: number; graded: number; averagePct: number | null };
  /** Student-body demographics from profiles (staff, school-wide). Each categorical
   *  profile parameter is a {value → count} map ready to chart. */
  demographics?: {
    profiled: number;
    gender: Record<string, number>;
    ageBand: Record<string, number>;
    state: Record<string, number>;
  };
  operations?: {
    students?: number;
    classes?: number;
    pendingApprovals?: number;
    integritySignals?: number;
  };
}
