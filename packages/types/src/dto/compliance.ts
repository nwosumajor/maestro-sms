// =============================================================================
// Compliance — what a school can tell its data-protection officer
// =============================================================================
// AGGREGATE POSTURE ONLY. Nothing here names a pupil: a DPO asks "how many, how
// long, and did you notify in time", not "who".
// =============================================================================

/** GDPR Art. 33(1): notify the supervisory authority within 72 hours of becoming
 *  aware. The clock runs from AWARENESS, not from when the breach happened. */
export const BREACH_NOTIFY_HOURS = 72;

export const BREACH_STATUSES = ["OPEN", "ASSESSED", "NOTIFIED", "CLOSED"] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

export const BREACH_RISK_LEVELS = ["LOW", "HIGH"] as const;
export type BreachRiskLevel = (typeof BREACH_RISK_LEVELS)[number];

export interface BreachIncidentDto {
  id: string;
  title: string;
  description: string;
  discoveredAt: Date;
  status: BreachStatus;
  riskLevel: BreachRiskLevel;
  affectedCount: number;
  dataCategories: string | null;
  notifiedAuthorityAt: Date | null;
  notifiedSubjectsAt: Date | null;
  noNotificationReason: string | null;
  reportedByName: string;
  closedAt: Date | null;
  createdAt: Date;

  // --- the clock, computed server-side so the page and the record agree --------
  /** When the Art. 33 notification is due. */
  notifyDueAt: Date;
  /** Hours left, negative once the deadline has passed. */
  hoursRemaining: number;
  /** Past 72 hours with no authority notification and no stated reason for not
   *  notifying. This is the condition that is itself a reportable failing. */
  overdue: boolean;
  /** HIGH risk, notified the authority, but never told the affected people. */
  subjectsUnnotified: boolean;
}

/** The one screen a school shows its DPO. */
export interface CompliancePostureDto {
  /** NDPR | GDPR | NONE — from the school's region. */
  regime: string;
  country: string;
  dpoName: string | null;
  dpoEmail: string | null;
  /** GDPR Art. 37: a school processing children's data at scale must designate a
   *  DPO. Flagged when the regime requires one and none is recorded. */
  dpoRequired: boolean;
  dpoMissing: boolean;

  breaches: {
    open: number;
    overdue: number;
    subjectsUnnotified: number;
    last90Days: number;
  };
  /** Right-to-erasure requests still awaiting a controller decision. */
  erasurePending: number;
  /** Days of behavioural telemetry on minors retained (School.integrityRetentionDays). */
  integrityRetentionDays: number;
  /** Guardian consents on file, and how many students have none — the coverage
   *  question a DPO asks about lawful basis. */
  consent: { recorded: number; studentsWithout: number };
}
