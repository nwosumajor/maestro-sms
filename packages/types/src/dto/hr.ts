// HR response DTOs.

export interface EmployeeDto {
  id: string;
  userId: string;
  jobTitle: string;
  department: string | null;
  employmentType: string;
  startDate: Date;
  status: string;
  salaryMinor: number | null;
  tin: string | null;
  rsaPin: string | null;
  /** PROBATION | CONFIRMED — flips only via the employment maker-checker. */
  confirmationStatus: string;
  probationEndsAt: Date | null;
  gradeLevel: string | null;
  /** Fixed-term contract end (null = open-ended). */
  endDate: Date | null;
  /** Line manager's user id (reporting line), or null. */
  managerId: string | null;
  user: { name: string; email: string } | null;
}

/** One node of the org chart (the web nests by managerId). */
export interface OrgNodeDto {
  userId: string;
  name: string;
  jobTitle: string;
  department: string | null;
  gradeLevel: string | null;
  managerId: string | null;
}

export interface ChecklistItemDto {
  id: string;
  label: string;
  sequence: number;
  done: boolean;
  doneAt: Date | null;
}

export interface StaffChecklistDto {
  id: string;
  userId: string;
  userName: string | null;
  type: string;
  status: string;
  createdAt: Date;
  items: ChecklistItemDto[];
}

export interface StaffDocumentDto {
  id: string;
  userId: string;
  userName: string | null;
  kind: string;
  name: string;
  documentId: string | null;
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
  reminderSentAt: Date | null;
  createdAt: Date;
}

export interface TrainingRecordDto {
  id: string;
  userId: string;
  userName: string | null;
  title: string;
  provider: string | null;
  status: string;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AppraisalDto {
  id: string;
  userId: string;
  userName: string | null;
  reviewerId: string;
  period: string;
  status: string;
  overallRating: number | null;
  summary: string | null;
  goals: string | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
}

export interface DisciplinaryEntryDto {
  id: string;
  note: string;
  authorId: string;
  createdAt: Date;
}

export interface DisciplinaryCaseDto {
  id: string;
  userId: string;
  userName: string | null;
  title: string;
  category: string | null;
  severity: string;
  status: string;
  openedById: string;
  createdAt: Date;
  entries: DisciplinaryEntryDto[];
}

/** A staff member's own profile (self-service). Personal fields decrypted for them. */
export interface SelfProfileDto {
  jobTitle: string;
  department: string | null;
  phone: string | null;
  address: string | null;
  nextOfKin: string | null;
  nextOfKinPhone: string | null;
  bankName: string | null;
  bankAccount: string | null;
}

export interface LeaveTypeDto {
  id: string;
  name: string;
  daysPerYear: number;
  active: boolean;
}

export interface LeaveBalanceDto {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  year: number;
  entitledDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface LeaveRequestDto {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  startDate: Date;
  endDate: Date;
  days: number;
  reason: string | null;
  status: string;
  workflowRequestId: string | null;
  attachmentDocId: string | null;
  user: { name: string } | null;
  createdAt: Date;
}

export interface HrAnalyticsDto {
  headcount: {
    active: number;
    /** Employment RECORDS on the HR register. */
    total: number;
    /** Staff USER ACCOUNTS (any non-student/non-parent role) — may exceed `total`. */
    staffAccounts: number;
    /** Staff accounts with NO employment record yet (need HR completion). */
    unrecorded: number;
  };
  byDepartment: { department: string; count: number }[];
  byEmploymentType: { type: string; count: number }[];
  leave: { pendingRequests: number; approvedThisYear: number; daysTakenThisYear: number };
  payroll: { latestPeriod: string | null; totalNetMinor: number; payslipCount: number };
  documents: { expiringSoon: number };
  training: { planned: number; completed: number };
  disciplinary: { openCases: number };
  appraisals: { draft: number; submitted: number; acknowledged: number };
  /** v2: turnover & workforce-shape signals (aggregates only, no PII). */
  attrition: { exitsLast12m: number; ratePercent: number };
  tenure: { under1y: number; y1to3: number; y3to5: number; over5y: number };
  payrollTrend: { period: string; runType: string; totalNetMinor: number }[];
  attendanceThisMonth: { present: number; late: number; absent: number; flagged: number };
  loans: { active: number; outstandingMinor: number };
  lifecycle: { onProbation: number; contractsEnding60d: number };
}

export interface JobRequisitionDto {
  id: string;
  title: string;
  department: string | null;
  description: string | null;
  status: string;
  openings: number;
  applicantCount: number;
  createdAt: Date;
}

export interface ApplicantDto {
  id: string;
  requisitionId: string;
  name: string;
  email: string;
  phone: string | null;
  stage: string;
  notes: string | null;
  convertedUserId: string | null;
  createdAt: Date;
}

export interface SalaryChangeDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  oldSalaryMinor: number | null;
  newSalaryMinor: number | null;
  reason: string | null;
  effectiveDate: Date | null;
  status: string;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface PayslipDto {
  id: string;
  userId: string;
  userName: string | null;
  grossMinor: number | null;
  deductionsMinor: number | null;
  netMinor: number | null;
}

export interface PayrollRunDto {
  id: string;
  periodYear: number;
  periodMonth: number;
  /** MONTHLY | THIRTEENTH | BONUS */
  runType: string;
  bonusPercent: number | null;
  status: string;
  totalGrossMinor: number;
  totalNetMinor: number;
  payslipCount: number;
  createdAt: Date;
  finalizedAt: Date | null;
  payslips?: PayslipDto[];
}

/** A recurring allowance/deduction configured on an employee (integer kobo). */
export interface PayComponentDto {
  id: string;
  userId: string;
  kind: "ALLOWANCE" | "DEDUCTION";
  name: string;
  amountMinor: number;
  active: boolean;
  createdAt: Date;
}

/** A staff loan / salary advance (maker-checker; recovered through payroll). */
export interface StaffLoanDto {
  id: string;
  userId: string;
  userName: string | null;
  purpose: string;
  principalMinor: number;
  monthlyMinor: number;
  balanceMinor: number;
  status: "PENDING" | "ACTIVE" | "REJECTED" | "SETTLED";
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  comment: string | null;
  createdAt: Date;
  /** Recovery history (present on detail reads). NULL run = exit settlement. */
  repayments?: { payrollRunId: string | null; period: string; amountMinor: number; createdAt: Date }[];
}

/** One of MY payslips (staff self-service; FINALIZED runs only). */
export interface MyPayslipDto {
  runId: string;
  periodYear: number;
  periodMonth: number;
  grossMinor: number | null;
  netMinor: number | null;
  finalizedAt: Date | null;
}

/** One staff member's attendance mark for a day. */
export interface StaffAttendanceDto {
  id: string;
  userId: string;
  userName: string | null;
  date: Date;
  status: "PRESENT" | "LATE" | "ABSENT";
  source: "ADMIN" | "SELF_KIOSK" | "BIOMETRIC";
  clockInAt: Date | null;
  /** Anomaly SIGNAL (off-site IP etc.) for human review — never auto-punitive. */
  flagged: boolean;
  note: string | null;
}

/** The day's register: every active employee with their mark (or none yet). */
export interface AttendanceRegisterDto {
  date: string;
  rows: { userId: string; userName: string; mark: StaffAttendanceDto | null }[];
}

/** Per-staff monthly roll-up. */
export interface AttendanceSummaryDto {
  year: number;
  month: number;
  rows: { userId: string; userName: string; present: number; late: number; absent: number; flagged: number }[];
}

/** Kiosk config as shown to HR (the TOTP secret NEVER leaves the server). */
export interface KioskConfigDto {
  enabled: boolean;
  allowedIps: string | null;
  windowStart: string;
  windowEnd: string;
  lateAfter: string;
}

/** The rotating gate-display code. */
export interface KioskCodeDto {
  code: string;
  secondsRemaining: number;
}

/** A dated duty-roster assignment (gate duty, night watch, weekend supervision). */
export interface DutyAssignmentDto {
  id: string;
  userId: string;
  userName: string | null;
  date: Date;
  title: string;
  startTime: string;
  endTime: string;
  note: string | null;
  createdAt: Date;
}

/** An employment lifecycle change (confirmation / promotion / renewal) —
 *  maker-checker; each row is the append-only employment history. */
export interface EmploymentChangeDto {
  id: string;
  userId: string;
  userName: string | null;
  type: "CONFIRMATION" | "PROMOTION" | "RENEWAL";
  newJobTitle: string | null;
  newGradeLevel: string | null;
  newEndDate: Date | null;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** A staff exit with its decrypted settlement (maker-checker; permanent record). */
export interface StaffExitDto {
  id: string;
  userId: string;
  userName: string | null;
  type: "RESIGNATION" | "TERMINATION" | "RETIREMENT";
  lastWorkingDay: Date;
  reason: string | null;
  settlement: import("../payroll").FinalSettlement;
  status: "PENDING" | "APPROVED" | "REJECTED";
  initiatedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}
