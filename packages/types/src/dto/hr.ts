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
  user: { name: string; email: string } | null;
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
  status: string;
  totalGrossMinor: number;
  totalNetMinor: number;
  payslipCount: number;
  createdAt: Date;
  finalizedAt: Date | null;
  payslips?: PayslipDto[];
}
