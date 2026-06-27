// HR — permission constants. hr_clerk owns the records; hr_manager adds the
// approval/payroll capabilities; school_admin/principal share read+write.
export const HR_PERMISSIONS = {
  /** Read employee records (salary decrypted for readers). */
  HR_READ: "hr.read",
  /** Create/update employee records (non-salary fields + initial salary on create). */
  HR_WRITE: "hr.write",
  /** Request a salary change (maker — goes to a separate approver). */
  HR_SALARY_REQUEST: "hr.salary.request",
  /** Approve/reject a pending salary change (checker — must differ from requester). */
  HR_SALARY_APPROVE: "hr.salary.approve",
  /** Configure leave types + adjust balances; review leave operationally. */
  HR_LEAVE_MANAGE: "hr.leave.manage",
  /** Create + finalize payroll runs. */
  HR_PAYROLL_RUN: "hr.payroll.run",
  /** Create/submit performance appraisals (the appraisee acknowledges their own). */
  HR_APPRAISAL_MANAGE: "hr.appraisal.manage",
  /** Open + manage disciplinary case files. */
  HR_DISCIPLINARY_MANAGE: "hr.disciplinary.manage",
} as const;
export type HrPermission = (typeof HR_PERMISSIONS)[keyof typeof HR_PERMISSIONS];
