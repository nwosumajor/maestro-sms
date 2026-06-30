// Transport Management — vehicles, routes, stops, assignments, transport fees.
export const TRANSPORT_PERMISSIONS = {
  /** View vehicles, routes, stops, assignments, seat availability. */
  TRANSPORT_READ: "transport.read",
  /** Manage vehicles/routes/stops, assign passengers, schedule fees. */
  TRANSPORT_MANAGE: "transport.manage",
} as const;
export type TransportPermission = (typeof TRANSPORT_PERMISSIONS)[keyof typeof TRANSPORT_PERMISSIONS];
