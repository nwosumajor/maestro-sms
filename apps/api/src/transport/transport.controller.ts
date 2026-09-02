import { isoDay } from "../common/calendar-day";
import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { TRANSPORT_PERMISSIONS, MODULES } from "@sms/types";
import type {
  RouteStopDto,
  TransportAssignmentDto,
  TransportBoardingDto,
  TransportFeeRunDto,
  TransportRouteDto,
  TransportSummaryDto,
  TransportTripDto,
  VehicleDto,
  VehicleLocationDto,
  VehicleMaintenanceDto,
} from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TransportService } from "./transport.service";

const customFields = z.record(z.string()).optional();
// A route's FARE is editable, not only its name. It could be set at creation and
// never corrected, so a school that picked the wrong mode had to retire the route
// and re-assign every rider — losing the assignments the fares hang off.
const routeRenameSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  fareMode: z.enum(["FLAT", "STOP"]).optional(),
  flatFareMinor: z.number().int().min(0).optional(),
});
const vehicleSchema = z.object({
  driverId: z.string().uuid().nullish(),
  name: z.string().min(1).max(160),
  regNumber: z.string().max(40).nullish(),
  capacity: z.number().int().min(0).max(200),
  customFields,
});
const vehicleUpdateSchema = z.object({
  driverId: z.string().uuid().nullish(),
  name: z.string().min(1).max(160).optional(),
  regNumber: z.string().max(40).nullish(),
  capacity: z.number().int().min(0).max(200).optional(),
  customFields,
});
const routeSchema = z.object({
  name: z.string().min(1).max(160),
  vehicleId: z.string().uuid().nullish(),
  sessionId: z.string().uuid().nullish(),
  fareMode: z.enum(["FLAT", "STOP"]).default("FLAT"),
  flatFareMinor: z.number().int().min(0).default(0),
  customFields,
});
const stopSchema = z.object({
  name: z.string().min(1).max(120),
  // No sequence: the server appends the stop to the end of the route. Reorder
  // via the reorder endpoint (drag/arrows), never a typed number.
  fareMinor: z.number().int().min(0).default(0),
  pickupTime: z.string().max(20).nullish(),
});
const reorderSchema = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(200) });
const assignSchema = z.object({
  routeId: z.string().uuid(),
  stopId: z.string().uuid().nullish(),
  passengerId: z.string().uuid(),
  passengerType: z.enum(["STUDENT", "STAFF"]).default("STUDENT"),
});
const changeSchema = z.object({ routeId: z.string().uuid(), stopId: z.string().uuid().nullish() });
const feeSchema = z.object({ routeId: z.string().uuid().optional(), dueDate: z.string(), description: z.string().max(200).optional() });

// The shared one — this file's own copy took `25:99`, and the trip list is
// ordered by this column as a string.
import { hhmm } from "../common/time-of-day";
const weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
const tripSchema = z.object({
  routeId: z.string().uuid(),
  direction: z.enum(["AM_PICKUP", "PM_DROPOFF"]).default("AM_PICKUP"),
  name: z.string().max(120).nullish(),
  departTime: hhmm,
  daysOfWeek: z.array(weekday).max(7).optional(),
});
const tripUpdateSchema = z.object({
  name: z.string().max(120).nullish(),
  departTime: hhmm.optional(),
  daysOfWeek: z.array(weekday).max(7).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const boardingSchema = z.object({
  routeId: z.string().uuid(),
  passengerId: z.string().uuid(),
  direction: z.enum(["PICKUP", "DROPOFF"]).default("PICKUP"),
  date: isoDay.optional(),
  method: z.enum(["SCAN", "MANUAL"]).default("MANUAL"),
  status: z.enum(["BOARDED", "ABSENT"]).default("BOARDED"),
});
const maintenanceSchema = z.object({
  vehicleId: z.string().uuid(),
  type: z.enum(["SERVICE", "REPAIR", "FUEL", "INSPECTION", "INSURANCE"]).default("SERVICE"),
  date: isoDay,
  costMinor: z.number().int().min(0).default(0),
  odometerKm: z.number().int().min(0).nullish(),
  litres: z.number().min(0).nullish(),
  vendor: z.string().max(160).nullish(),
  notes: z.string().max(1000).nullish(),
});
const locationSchema = z.object({
  vehicleId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speedKph: z.number().min(0).max(400).nullish(),
  headingDeg: z.number().min(0).max(360).nullish(),
});

@RequireModule(MODULES.TRANSPORT)
@Controller("transport")
export class TransportController {
  constructor(private readonly transport: TransportService) {}

  // vehicles
  @Get("vehicles")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  vehicles(@CurrentPrincipal() p: Principal): Promise<VehicleDto[]> {
    return this.transport.listVehicles(p);
  }

  /** Fleet analytics (driver-scoped or school-wide). */
  @Get("summary")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  summary(@CurrentPrincipal() p: Principal): Promise<TransportSummaryDto> {
    return this.transport.summary(p);
  }
  @Post("vehicles")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  createVehicle(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(vehicleSchema)) b: z.infer<typeof vehicleSchema>): Promise<VehicleDto> {
    return this.transport.createVehicle(p, b);
  }
  @Put("vehicles/:id")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  updateVehicle(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(vehicleUpdateSchema)) b: z.infer<typeof vehicleUpdateSchema>): Promise<VehicleDto> {
    return this.transport.updateVehicle(p, id, b);
  }

  // routes + stops
  @Get("routes")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  routes(@CurrentPrincipal() p: Principal): Promise<TransportRouteDto[]> {
    return this.transport.listRoutes(p);
  }
  @Post("routes")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  createRoute(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(routeSchema)) b: z.infer<typeof routeSchema>): Promise<TransportRouteDto> {
    return this.transport.createRoute(p, b);
  }
  /** Delete a vehicle no route uses (admin-only; 409 with the reason otherwise). */
  @Delete("vehicles/:id")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  deleteVehicle(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.transport.deleteVehicle(p, id);
  }

  /** Edit a route's name or fare (assignments, stops and fees follow the route id). */
  @Put("routes/:id")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  updateRoute(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(routeRenameSchema)) body: z.infer<typeof routeRenameSchema>,
  ) {
    return this.transport.updateRoute(p, id, body);
  }

  @Post("routes/:id/retire")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  retireRoute(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TransportRouteDto> {
    return this.transport.retireRoute(p, id);
  }
  @Post("routes/:id/stops")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  addStop(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(stopSchema)) b: z.infer<typeof stopSchema>): Promise<RouteStopDto> {
    return this.transport.addStop(p, id, b);
  }

  /** Reorder a route's stops from an explicit id list (arrows/drag, not a number). */
  @Post("routes/:id/stops/reorder")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  reorderStops(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(reorderSchema)) b: z.infer<typeof reorderSchema>): Promise<RouteStopDto[]> {
    return this.transport.reorderStops(p, id, b.orderedIds);
  }

  // assignments
  @Get("assignments")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  assignments(@CurrentPrincipal() p: Principal, @Query("routeId") routeId?: string): Promise<TransportAssignmentDto[]> {
    return this.transport.listAssignments(p, routeId);
  }
  @Post("assignments")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  assign(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(assignSchema)) b: z.infer<typeof assignSchema>): Promise<TransportAssignmentDto> {
    return this.transport.assign(p, b);
  }
  @Post("assignments/:id/change-route")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  changeRoute(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(changeSchema)) b: z.infer<typeof changeSchema>): Promise<TransportAssignmentDto> {
    return this.transport.changeRoute(p, id, b);
  }
  @Post("assignments/:id/cancel")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<TransportAssignmentDto> {
    return this.transport.cancelAssignment(p, id);
  }

  // fees
  @Post("fees/schedule")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  scheduleFees(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(feeSchema)) b: z.infer<typeof feeSchema>): Promise<TransportFeeRunDto | { pendingApproval: true; requestId: string }> {
    return this.transport.scheduleFees(p, b);
  }

  // --- trips (AM pickup / PM drop-off schedules) — config (manage) ---
  @Get("trips")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  trips(@CurrentPrincipal() p: Principal, @Query("routeId") routeId?: string): Promise<TransportTripDto[]> {
    return this.transport.listTrips(p, routeId);
  }

  @Post("trips")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  createTrip(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(tripSchema)) b: z.infer<typeof tripSchema>): Promise<TransportTripDto> {
    return this.transport.createTrip(p, b);
  }

  @Put("trips/:id")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  updateTrip(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(tripUpdateSchema)) b: z.infer<typeof tripUpdateSchema>): Promise<TransportTripDto> {
    return this.transport.updateTrip(p, id, b);
  }

  // --- boarding confirmation — gated by READ so a DRIVER (transport.read) can
  //     record it for THEIR route; the service scopes non-fleet-wide callers to
  //     their own routes. Recording a PICKUP alerts the student's guardians. ---
  @Get("boardings")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  boardings(@CurrentPrincipal() p: Principal, @Query("routeId") routeId: string, @Query("date") date: string): Promise<TransportBoardingDto[]> {
    return this.transport.listBoardings(p, routeId, date);
  }

  @Post("boardings")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  recordBoarding(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(boardingSchema)) b: z.infer<typeof boardingSchema>): Promise<TransportBoardingDto> {
    return this.transport.recordBoarding(p, b);
  }

  // --- maintenance / fuel log — config/finance (manage) ---
  @Get("maintenance")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  maintenance(@CurrentPrincipal() p: Principal, @Query("vehicleId") vehicleId?: string): Promise<VehicleMaintenanceDto[]> {
    return this.transport.listMaintenance(p, vehicleId);
  }

  @Post("maintenance")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_MANAGE)
  addMaintenance(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(maintenanceSchema)) b: z.infer<typeof maintenanceSchema>): Promise<VehicleMaintenanceDto> {
    return this.transport.addMaintenance(p, b);
  }

  // --- live GPS — ingest gated by READ (the driver's own vehicle / device);
  //     the map read is READ. High-volume ping stream, not audited per point. ---
  @Get("locations")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  locations(@CurrentPrincipal() p: Principal): Promise<VehicleLocationDto[]> {
    return this.transport.latestLocations(p);
  }

  @Post("locations")
  @RequirePermission(TRANSPORT_PERMISSIONS.TRANSPORT_READ)
  ingestLocation(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(locationSchema)) b: z.infer<typeof locationSchema>) {
    return this.transport.ingestLocation(p, b);
  }
}
