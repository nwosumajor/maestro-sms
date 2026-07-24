// Hostel Management response DTOs (server form; Date fields are Date).

export interface HostelRoomDto {
  id: string;
  hostelId: string;
  roomNumber: string;
  roomType: string;
  capacity: number;
  rentMinor: number;
  customFields: Record<string, string>;
  /** Active allocations currently occupying the room. */
  occupied: number;
  /** capacity - occupied (never negative). */
  available: number;
}

export interface HostelDto {
  id: string;
  name: string;
  type: string;
  wardenId: string | null;
  wardenName: string | null;
  customFields: Record<string, string>;
  rooms: HostelRoomDto[];
  /** Sum of room capacities / occupancy for a one-click availability view. */
  totalBeds: number;
  occupiedBeds: number;
  availableBeds: number;
  createdAt: Date;
}

export interface HostelAllocationDto {
  id: string;
  roomId: string;
  hostelName: string;
  roomNumber: string;
  studentId: string;
  studentName: string;
  status: string;
  rentMinor: number;
  allocatedAt: Date;
  vacatedAt: Date | null;
}

/** Result of scheduling hostel fees: how many invoices/line items were raised. */
export interface HostelFeeRunDto {
  invoicesCreated: number;
  totalBilledMinor: number;
  studentsBilled: number;
}

/** Occupancy analytics for the hostel module (warden-scoped or school-wide). */
export interface HostelSummaryDto {
  hostels: number;
  rooms: number;
  beds: number;      // total capacity across rooms
  occupied: number;  // active allocations
  vacant: number;
  occupancyPct: number | null;
}

export const HOSTEL_ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "EXEAT", "SICK", "LATE"] as const;
export type HostelAttendanceStatus = (typeof HOSTEL_ATTENDANCE_STATUSES)[number];

export interface HostelAttendanceDto {
  id: string;
  hostelId: string;
  studentId: string;
  studentName: string;
  date: Date;
  status: string;
  note: string | null;
  takenById: string;
}

export const EXEAT_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "DEPARTED", "RETURNED", "CANCELLED"] as const;
export type ExeatStatus = (typeof EXEAT_STATUSES)[number];

export interface HostelExeatDto {
  id: string;
  hostelId: string;
  hostelName: string;
  studentId: string;
  studentName: string;
  reason: string;
  destination: string | null;
  departAt: Date;
  expectedReturnAt: Date;
  actualReturnAt: Date | null;
  status: string;
  requestedById: string;
  decidedById: string | null;
  decidedAt: Date | null;
  note: string | null;
  createdAt: Date;
}

export const HOSTEL_INCIDENT_CATEGORIES = ["MAINTENANCE", "DISCIPLINE", "HEALTH", "SECURITY", "OTHER"] as const;
export type HostelIncidentCategory = (typeof HOSTEL_INCIDENT_CATEGORIES)[number];

export interface HostelIncidentDto {
  id: string;
  hostelId: string;
  hostelName: string;
  roomId: string | null;
  roomNumber: string | null;
  category: string;
  title: string;
  description: string | null;
  status: string;
  reportedById: string;
  reportedByName: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}
