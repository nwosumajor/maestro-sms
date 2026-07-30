// Role-scoped analytics overview response DTO.

/** The window an overview was computed over, echoed back so the page can SAY what
 *  it is showing. A figure with no stated period is the one people misquote. */
export interface AnalyticsPeriodDto {
  from: string;
  to: string;
  /** Human label: the term's name, or "Last 30 days" / an explicit range. */
  label: string;
  /** The term this window came from, when it came from one. */
  termId: string | null;
}

export interface AnalyticsOverviewDto {
  scope: "school" | "family";
  /** Always present: what period these numbers cover. */
  period?: AnalyticsPeriodDto;
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

/** Home-page tile counts. Each one is a COUNT in Postgres over the caller's own
 *  scope — the dashboard used to fetch whole lists and count them in the browser,
 *  which also made the approvals figure under-report past the list cap. */
export interface DashboardSummaryDto {
  pendingApprovals: number;
  classes: number;
  unreadNotifications: number;
}
