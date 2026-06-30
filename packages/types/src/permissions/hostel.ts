// Hostel Management — boarding houses, rooms, allocations, hostel fees.
export const HOSTEL_PERMISSIONS = {
  /** View hostels, rooms, allocations, availability. Warden / staff. */
  HOSTEL_READ: "hostel.read",
  /** Create/edit hostels & rooms, allocate students, schedule fees. Warden / admin. */
  HOSTEL_MANAGE: "hostel.manage",
} as const;
export type HostelPermission = (typeof HOSTEL_PERMISSIONS)[keyof typeof HOSTEL_PERMISSIONS];
