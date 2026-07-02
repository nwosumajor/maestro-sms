import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { TRANSPORT_PERMISSIONS, MODULES } from "@sms/types";
import type {
  RouteStopDto,
  TransportAssignmentDto,
  TransportFeeRunDto,
  TransportRouteDto,
  TransportSummaryDto,
  VehicleDto,
} from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { TransportService } from "./transport.service";

const customFields = z.record(z.string()).optional();
const routeRenameSchema = z.object({ name: z.string().min(1).max(120) });
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
  sequence: z.number().int().min(0).default(0),
  fareMinor: z.number().int().min(0).default(0),
  pickupTime: z.string().max(20).nullish(),
});
const assignSchema = z.object({
  routeId: z.string().uuid(),
  stopId: z.string().uuid().nullish(),
  passengerId: z.string().uuid(),
  passengerType: z.enum(["STUDENT", "STAFF"]).default("STUDENT"),
});
const changeSchema = z.object({ routeId: z.string().uuid(), stopId: z.string().uuid().nullish() });
const feeSchema = z.object({ routeId: z.string().uuid().optional(), dueDate: z.string(), description: z.string().max(200).optional() });

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

  /** Rename a route (assignments, stops and fees follow the route id). */
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
}
