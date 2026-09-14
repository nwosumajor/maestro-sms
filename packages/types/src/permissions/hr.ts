// HR — permission constants. hr_clerk owns the records; hr_manager adds the
// approval/payroll capabilities; school_admin/principal share read+write.
export const HR_PERMISSIONS = {
  /** Read employee records (salary decrypted for readers). */
  HR_READ: "hr.read",
  /** Staff self-service: a staff member acts on their OWN HR records (profile,
   *  leave, payslip, appraisal acknowledgement, NDPR export/erase). */
  HR_SELF: "hr.self",
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
  /** Manage recruitment: job requisitions + applicants (incl. convert-to-staff). */
  HR_RECRUIT_MANAGE: "hr.recruit.manage",
  /**
   * READ the staff attendance register, and AMEND it — deliberately two
   * permissions where there was one.
   *
   * `hr.read` and `hr.write` were held by exactly the same four roles, so
   * everyone who could see the register could also overwrite any mark for any
   * person on any date, INCLUDING THEIR OWN, with no second signature. That is
   * the record cited in a lateness conversation and a disciplinary file. Salary
   * changes are maker-checker and amending a PUPIL register past a week needs a
   * second approver; the staff register had neither.
   */
  HR_ATTENDANCE_READ: "hr.attendance.read",
  HR_ATTENDANCE_AMEND: "hr.attendance.amend",
  /**
   * Show the rotating gate code on a display — and NOTHING else.
   *
   * The code lived on the HR attendance page, so the screen standing at the gate
   * all day had to be signed in as somebody with `hr.read`: a device in a public
   * corridor rendering every member of staff's attendance and the month's
   * roll-up beside the six digits it was there to show. This is the narrowest
   * permission in the module on purpose — it opens one number and one page.
   */
  HR_KIOSK_DISPLAY: "hr.kiosk.display",
} as const;
export type HrPermission = (typeof HR_PERMISSIONS)[keyof typeof HR_PERMISSIONS];
