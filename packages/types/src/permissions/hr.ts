// HR — permission constants. hr_clerk owns it; school_admin/principal share it.
export const HR_PERMISSIONS = {
  /** Read employee records (salary decrypted for readers). */
  HR_READ: "hr.read",
  /** Create/update employee records. */
  HR_WRITE: "hr.write",
} as const;
export type HrPermission = (typeof HR_PERMISSIONS)[keyof typeof HR_PERMISSIONS];
