// Transport Management response DTOs (server form; Date fields are Date).

export interface VehicleDto {
  id: string;
  name: string;
  regNumber: string | null;
  capacity: number;
  /** The assigned driver (a staff User with the `driver` role), if any. */
  driverId: string | null;
  customFields: Record<string, string>;
  createdAt: Date;
}

export interface RouteStopDto {
  id: string;
  routeId: string;
  name: string;
  sequence: number;
  fareMinor: number;
  pickupTime: string | null;
}

export interface TransportRouteDto {
  id: string;
  name: string;
  vehicleId: string | null;
  vehicleName: string | null;
  sessionId: string | null;
  fareMode: string;
  flatFareMinor: number;
  status: string;
  customFields: Record<string, string>;
  stops: RouteStopDto[];
  /** Vehicle capacity (0 if no vehicle), active assignments, and free seats. */
  capacity: number;
  seatsUsed: number;
  seatsAvailable: number;
  createdAt: Date;
}

export interface TransportAssignmentDto {
  id: string;
  routeId: string;
  routeName: string;
  stopId: string | null;
  stopName: string | null;
  passengerId: string;
  passengerName: string;
  passengerType: string;
  status: string;
  /** Fare this passenger owes (flat route fare, or their stop's fare). */
  fareMinor: number;
}

export interface TransportFeeRunDto {
  invoicesCreated: number;
  totalBilledMinor: number;
  passengersBilled: number;
}

/** Fleet analytics for the transport module (driver-scoped or school-wide). */
export interface TransportSummaryDto {
  vehicles: number;
  routes: number;     // ACTIVE routes
  stops: number;
  passengers: number; // ACTIVE assignments
  seats: number;      // total vehicle capacity
  seatsUsed: number;
}
