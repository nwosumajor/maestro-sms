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

export const TRIP_DIRECTIONS = ["AM_PICKUP", "PM_DROPOFF"] as const;
export type TripDirection = (typeof TRIP_DIRECTIONS)[number];
export const WEEKDAYS_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export interface TransportTripDto {
  id: string;
  routeId: string;
  routeName: string;
  direction: string;
  name: string | null;
  departTime: string;
  daysOfWeek: string[];
  status: string;
}

export const BOARDING_DIRECTIONS = ["PICKUP", "DROPOFF"] as const;
export type BoardingDirection = (typeof BOARDING_DIRECTIONS)[number];

export interface TransportBoardingDto {
  id: string;
  tripId: string | null;
  routeId: string;
  passengerId: string;
  passengerName: string;
  date: Date;
  direction: string;
  status: string;
  method: string;
  recordedById: string;
  recordedAt: Date;
}

export const MAINTENANCE_TYPES = ["SERVICE", "REPAIR", "FUEL", "INSPECTION", "INSURANCE"] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export interface VehicleMaintenanceDto {
  id: string;
  vehicleId: string;
  vehicleName: string;
  type: string;
  date: Date;
  costMinor: number;
  odometerKm: number | null;
  litres: number | null;
  vendor: string | null;
  notes: string | null;
  recordedById: string;
  createdAt: Date;
}

export interface VehicleLocationDto {
  vehicleId: string;
  vehicleName: string;
  lat: number;
  lng: number;
  speedKph: number | null;
  headingDeg: number | null;
  recordedAt: Date;
}
