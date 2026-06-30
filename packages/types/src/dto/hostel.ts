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
