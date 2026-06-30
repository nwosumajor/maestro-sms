// Alumni Management.
export const ALUMNI_PERMISSIONS = {
  /** View + manage alumni records and broadcasts. Staff. */
  ALUMNI_MANAGE: "alumni.manage",
} as const;
export type AlumniPermission = (typeof ALUMNI_PERMISSIONS)[keyof typeof ALUMNI_PERMISSIONS];
