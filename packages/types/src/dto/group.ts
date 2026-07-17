// Multi-school GROUP console DTOs (server form; web consumes Serialized<...>).
// AGGREGATES ONLY — the cross-campus surface never carries student PII.

export interface GroupSchoolStatsDto {
  schoolId: string;
  name: string;
  slug: string;
  active: boolean;
  students: number;
  staff: number;
  /** Present % across today's registers; null when none were taken yet. */
  attendanceTodayPct: number | null;
  collectedThisMonthMinor: number;
  outstandingFeesMinor: number;
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: Date | null;
}

export interface GroupOverviewDto {
  groupId: string;
  groupName: string;
  schools: GroupSchoolStatsDto[];
  totals: {
    students: number;
    staff: number;
    collectedThisMonthMinor: number;
    outstandingFeesMinor: number;
  };
}
