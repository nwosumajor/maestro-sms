// =============================================================================
// TransportService — school bus / route management
// =============================================================================
// Tenant-scoped (RLS). Admins maintain vehicles (with fuel/repair/licence/
// pollution custom fields), routes + stops (academic-year-wise), assign
// students/staff to a route+stop within seat availability, and schedule transport
// fees that bill through the SHARED Fees tables (collected alongside academic
// fees). Changing a passenger's route alerts their guardians via Notifications.
// All mutations audited.
// =============================================================================

import { ConflictException, BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { schoolToday } from "@sms/types";
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
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { WorkflowService } from "../workflow/workflow.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { NotificationService } from "../notifications/notification.service";
import { assertStillHere } from "../common/still-here";

type Json = Record<string, string>;

/** How long a GPS breadcrumb is kept. A live feed is high-volume (a bus pinging
 *  every 10s is ~3k rows/day/vehicle), and only the recent trail has value, so
 *  the stream is pruned on write and can never grow without bound. */
const LOCATION_RETENTION_DAYS = 7;

@Injectable()
export class TransportService {
  private readonly logger = new Logger("Transport");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
    // Last, so the positional constructor calls in the existing suites keep
    // meaning what they meant.
    private readonly region: SchoolRegionService,
  ) {
    // Maker-checker reactor: an APPROVED FEE_SCHEDULE request raised by the head
    // driver posts the fare run in the SAME tenant tx as the approval (atomic).
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "FEE_SCHEDULE" || req.state !== "APPROVED") return;
      const pl = req.payload as { module?: string; routeId?: string | null; dueDate?: string; description?: string | null } | null;
      if (pl?.module !== "transport" || !pl.dueDate) return;
      await this.postFeeRun(tx, req.schoolId, req.initiatorId, {
        routeId: pl.routeId ?? undefined,
        due: new Date(pl.dueDate),
        description: pl.description ?? undefined,
      });
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private cf(v: unknown): Json {
    return (v ?? {}) as Json;
  }
  // school_admin / principal see the whole fleet; a driver sees ONLY their own
  // vehicle + its routes + passengers.
  // SECURITY: no super_admin. This once read "(and an impersonating super_admin)",
  // which is not how impersonation works — it mints the TARGET user's roles and
  // never super_admin, so the entry granted a standing platform scope over a
  // school's fleet on the strength of a false belief about the mechanism.
  private wide(p: Principal): boolean {
    return p.roles.some((r) => r === "school_admin" || r === "principal");
  }
  /** Module-wide scoping: admins AND the head driver see/manage the whole fleet.
   *  junior_admin (operational records tier) holds transport.read and is included
   *  here for READ visibility across the fleet — it never gains write power, since
   *  every mutating endpoint is @RequirePermission(transport.manage), which
   *  junior_admin does not hold. Structural acts (delete vehicle) stay
   *  wide()-only; fee runs are maker-checker for everyone below wide(). */
  private moduleWide(p: Principal): boolean {
    return this.wide(p) || p.roles.includes("head_driver") || p.roles.includes("junior_admin");
  }

  // --- vehicles -------------------------------------------------------------

  async createVehicle(
    p: Principal,
    input: { name: string; regNumber?: string | null; capacity: number; driverId?: string | null; customFields?: Json },
  ): Promise<VehicleDto> {
    if (input.capacity < 0) throw new BadRequestException("capacity cannot be negative");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.driverId) await this.assertUserInSchool(tx, input.driverId);
      const v = await tx.vehicle.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          regNumber: input.regNumber ?? null,
          capacity: input.capacity,
          driverId: input.driverId ?? null,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "transport.vehicle.create", v.id, { name: input.name, capacity: input.capacity });
      return this.vehicleDto(v);
    });
  }

  async updateVehicle(
    p: Principal,
    id: string,
    input: { name?: string; regNumber?: string | null; capacity?: number; driverId?: string | null; customFields?: Json },
  ): Promise<VehicleDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id } });
      if (!v) throw new NotFoundException("Vehicle not found");
      if (input.driverId) await this.assertUserInSchool(tx, input.driverId);
      const updated = await tx.vehicle.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.regNumber !== undefined ? { regNumber: input.regNumber } : {}),
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.driverId !== undefined ? { driverId: input.driverId } : {}),
          ...(input.customFields !== undefined ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
        },
      });
      await this.log(tx, p, "transport.vehicle.update", id, { fields: Object.keys(input) });
      return this.vehicleDto(updated);
    });
  }

  async listVehicles(p: Principal): Promise<VehicleDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const vs = await tx.vehicle.findMany({ where: this.moduleWide(p) ? {} : { driverId: p.userId }, orderBy: { name: "asc" } });
      return vs.map((v) => this.vehicleDto(v));
    });
  }

  /** Delete a vehicle no route uses (duplicate/typo cleanup; 409 otherwise). */
  async deleteVehicle(p: Principal, id: string): Promise<{ ok: boolean }> {
    if (!this.wide(p)) throw new ForbiddenException("Only an administrator can delete a vehicle");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id } });
      if (!v) throw new NotFoundException("Vehicle not found");
      const routes = await tx.transportRoute.count({ where: { vehicleId: id } });
      if (routes > 0) {
        throw new ConflictException(
          `"${v.name}" is attached to ${routes} route${routes === 1 ? "" : "s"} (including retired ones) — reassign or retire-and-detach those routes first, or rename the vehicle instead`,
        );
      }
      await tx.vehicle.delete({ where: { id } });
      await this.log(tx, p, "transport.vehicle.delete", id, { name: v.name });
      return { ok: true };
    });
  }

  /** Rename a route (typo/duplicate fix; assignments and stops follow the id). */
  async updateRoute(p: Principal, id: string, input: { name: string }): Promise<TransportRouteDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await tx.transportRoute.findFirst({ where: { id } });
      if (!r) throw new NotFoundException("Route not found");
      await tx.transportRoute.update({ where: { id }, data: { name: input.name } });
      await this.log(tx, p, "transport.route.update", id, { from: r.name, to: input.name });
      return this.routeDto(tx, id);
    });
  }

  // --- routes + stops -------------------------------------------------------

  async createRoute(
    p: Principal,
    input: {
      name: string;
      vehicleId?: string | null;
      sessionId?: string | null;
      fareMode: "FLAT" | "STOP";
      flatFareMinor: number;
      customFields?: Json;
    },
  ): Promise<TransportRouteDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.vehicleId) {
        const veh = await tx.vehicle.findFirst({ where: { id: input.vehicleId }, select: { id: true } });
        if (!veh) throw new NotFoundException("Vehicle not found");
      }
      const r = await tx.transportRoute.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          vehicleId: input.vehicleId ?? null,
          sessionId: input.sessionId ?? null,
          fareMode: input.fareMode,
          flatFareMinor: input.flatFareMinor,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.log(tx, p, "transport.route.create", r.id, { name: input.name, fareMode: input.fareMode });
      return this.routeDto(tx, r.id);
    });
  }

  /** Retire a redundant route (history kept; not hard-deleted). */
  async retireRoute(p: Principal, id: string): Promise<TransportRouteDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = await tx.transportRoute.findFirst({ where: { id } });
      if (!r) throw new NotFoundException("Route not found");
      await tx.transportRoute.update({ where: { id }, data: { status: "RETIRED" } });
      await this.log(tx, p, "transport.route.retire", id, {});
      return this.routeDto(tx, id);
    });
  }

  async addStop(
    p: Principal,
    routeId: string,
    input: { name: string; fareMinor: number; pickupTime?: string | null },
  ): Promise<RouteStopDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const route = await tx.transportRoute.findFirst({ where: { id: routeId }, select: { id: true } });
      if (!route) throw new NotFoundException("Route not found");
      // The sequence is SERVER-assigned (append to the end of the route) — never
      // taken from the caller — so it can't be negative, duplicated, or out of
      // order. Reorder via reorderStops if a stop was added in the wrong place.
      const agg = await tx.routeStop.aggregate({ where: { routeId }, _max: { sequence: true } });
      const sequence = (agg._max.sequence ?? 0) + 1;
      const s = await tx.routeStop.create({
        data: {
          schoolId: p.schoolId,
          routeId,
          name: input.name,
          sequence,
          fareMinor: input.fareMinor,
          pickupTime: input.pickupTime ?? null,
        },
      });
      await this.log(tx, p, "transport.stop.create", s.id, { routeId, name: input.name, sequence });
      return this.stopDto(s);
    });
  }

  /** Reassign stop order from an explicit id list (index+1). The list must be
   *  exactly the route's current stops — so order is set by drag/arrows, never by
   *  a typed number. */
  async reorderStops(p: Principal, routeId: string, orderedIds: string[]): Promise<RouteStopDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const route = await tx.transportRoute.findFirst({ where: { id: routeId }, select: { id: true } });
      if (!route) throw new NotFoundException("Route not found");
      const stops = (await tx.routeStop.findMany({ where: { routeId }, select: { id: true } })) as Array<{ id: string }>;
      const current = new Set(stops.map((s) => s.id));
      if (orderedIds.length !== current.size || orderedIds.some((id) => !current.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
        throw new BadRequestException("The order must list each of this route's stops exactly once.");
      }
      // Single pass: route_stop.sequence has NO unique constraint, so writing the
      // final 1..N values directly can't collide — no two-phase needed.
      await Promise.all(orderedIds.map((id, i) => tx.routeStop.update({ where: { id }, data: { sequence: i + 1 } })));
      await this.log(tx, p, "transport.stops.reorder", routeId, { count: orderedIds.length });
      const rows = await tx.routeStop.findMany({ where: { routeId }, orderBy: { sequence: "asc" } });
      return rows.map((s) => this.stopDto(s));
    });
  }

  /** Fleet analytics — driver-scoped to their vehicle/route, else school-wide. */
  async summary(p: Principal): Promise<TransportSummaryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const vehicles = await tx.vehicle.findMany({ where: this.moduleWide(p) ? {} : { driverId: p.userId }, select: { id: true, capacity: true } });
      const seats = vehicles.reduce((n, v) => n + v.capacity, 0);
      const routes = await tx.transportRoute.findMany({ where: this.wide(p) ? { status: "ACTIVE" } : { status: "ACTIVE", vehicle: { driverId: p.userId } }, select: { id: true } });
      const routeIds = routes.map((r) => r.id);
      const stops = routeIds.length ? await tx.routeStop.count({ where: { routeId: { in: routeIds } } }) : 0;
      const passengers = await tx.transportAssignment.count({ where: this.wide(p) ? { status: "ACTIVE" } : { status: "ACTIVE", route: { vehicle: { driverId: p.userId } } } });
      return { vehicles: vehicles.length, routes: routes.length, stops, passengers, seats, seatsUsed: passengers };
    });
  }

  async listRoutes(p: Principal): Promise<TransportRouteDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const routes = await tx.transportRoute.findMany({ where: this.moduleWide(p) ? {} : { vehicle: { driverId: p.userId } }, orderBy: { name: "asc" } });
      return Promise.all(routes.map((r: { id: string }) => this.routeDto(tx, r.id)));
    });
  }

  // --- assignments (seat-availability gated) --------------------------------

  async assign(
    p: Principal,
    input: { routeId: string; stopId?: string | null; passengerId: string; passengerType: "STUDENT" | "STAFF" },
  ): Promise<TransportAssignmentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const route = await tx.transportRoute.findFirst({ where: { id: input.routeId } });
      if (!route) throw new NotFoundException("Route not found");
      if (route.status !== "ACTIVE") throw new BadRequestException("Route is retired");
      const passenger = await tx.user.findFirst({ where: { id: input.passengerId }, select: { id: true } });
      if (!passenger) throw new NotFoundException("Passenger not found in this school");
      if (input.stopId) {
        const stop = await tx.routeStop.findFirst({ where: { id: input.stopId, routeId: input.routeId }, select: { id: true } });
        if (!stop) throw new BadRequestException("Stop does not belong to this route");
      }
      // Seat availability: vehicle capacity minus active assignments on the route.
      //
      // Locked first, like a hostel room: these are physical seats on a bus, and
      // a count-then-insert lets two racers take the last one. The route is the
      // thing being contended, so it is the row to hold.
      const capacity = await this.routeCapacity(tx, route.vehicleId);
      if (capacity > 0) {
        await tx.$executeRaw`SELECT id FROM "transport_route" WHERE id = ${input.routeId}::uuid FOR UPDATE`;
      }
      const used = await tx.transportAssignment.count({ where: { routeId: input.routeId, status: "ACTIVE" } });
      if (capacity > 0 && used >= capacity) throw new BadRequestException("Route is at full seat capacity");
      // A passenger holds at most one ACTIVE assignment.
      const existing = await tx.transportAssignment.findFirst({ where: { passengerId: input.passengerId, status: "ACTIVE" }, select: { id: true } });
      if (existing) throw new BadRequestException("Passenger already has an active transport assignment");
      const a = await tx.transportAssignment.create({
        data: {
          schoolId: p.schoolId,
          routeId: input.routeId,
          stopId: input.stopId ?? null,
          passengerId: input.passengerId,
          passengerType: input.passengerType,
          status: "ACTIVE",
        },
      });
      await this.log(tx, p, "transport.assign", a.id, { routeId: input.routeId, passengerId: input.passengerId });
      return this.assignmentDto(tx, a.id);
    });
  }

  /** Move a passenger to a different route/stop and ALERT their guardians. */
  async changeRoute(p: Principal, assignmentId: string, input: { routeId: string; stopId?: string | null }) {
    const alerts: Array<{ guardianId: string; routeName: string; studentName: string }> = [];
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.transportAssignment.findFirst({ where: { id: assignmentId } });
      if (!a) throw new NotFoundException("Assignment not found");
      if (a.status !== "ACTIVE") throw new BadRequestException("Assignment is not active");
      const route = await tx.transportRoute.findFirst({ where: { id: input.routeId } });
      if (!route || route.status !== "ACTIVE") throw new BadRequestException("Target route is invalid or retired");
      if (input.stopId) {
        const stop = await tx.routeStop.findFirst({ where: { id: input.stopId, routeId: input.routeId }, select: { id: true } });
        if (!stop) throw new BadRequestException("Stop does not belong to the target route");
      }
      await tx.transportAssignment.update({ where: { id: assignmentId }, data: { routeId: input.routeId, stopId: input.stopId ?? null } });
      await this.log(tx, p, "transport.route.change", assignmentId, { from: a.routeId, to: input.routeId, passengerId: a.passengerId });

      // Collect guardian alerts (students only) to fire AFTER the tx commits.
      if (a.passengerType === "STUDENT") {
        const student = await tx.user.findFirst({ where: { id: a.passengerId }, select: { name: true } });
        const links = await tx.parentChild.findMany({ where: { studentId: a.passengerId }, select: { parentId: true } });
        for (const l of links as Array<{ parentId: string }>) {
          alerts.push({ guardianId: l.parentId, routeName: route.name, studentName: student?.name ?? "your child" });
        }
      }
      return this.assignmentDto(tx, assignmentId);
    });
    for (const al of alerts) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: al.guardianId,
          type: "TRANSPORT_ROUTE_CHANGE",
          title: "Transport route change",
          body: `${al.studentName}'s bus route has changed to "${al.routeName}".`,
          data: { assignmentId, routeId: input.routeId },
          channels: ["EMAIL"],
        });
      } catch (err) {
        this.logger.error(`Transport route-change alert failed for guardian ${al.guardianId}: ${String(err)}`);
      }
    }
    return result;
  }

  async cancelAssignment(p: Principal, id: string): Promise<TransportAssignmentDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.transportAssignment.findFirst({ where: { id } });
      if (!a) throw new NotFoundException("Assignment not found");
      if (a.status !== "ACTIVE") throw new BadRequestException("Assignment is not active");
      await tx.transportAssignment.update({ where: { id }, data: { status: "CANCELLED" } });
      await this.log(tx, p, "transport.assign.cancel", id, { routeId: a.routeId, passengerId: a.passengerId });
      return this.assignmentDto(tx, id);
    });
  }

  async listAssignments(p: Principal, routeId?: string): Promise<TransportAssignmentDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const scope = this.moduleWide(p) ? {} : { route: { vehicle: { driverId: p.userId } } };
      const where = { ...(routeId ? { routeId } : {}), status: "ACTIVE", ...scope };
      const rows = await tx.transportAssignment.findMany({ where, orderBy: { createdAt: "desc" } });
      if (rows.length === 0) return [];
      // Batch route/stop/passenger lookups (was up to 6 queries per assignment
      // via assignmentDto+fareFor — hundreds for a full route). Route + stop rows
      // carry the fare fields, so fare is computed in-memory by the mapper.
      const routes = await tx.transportRoute.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.routeId))] } },
        select: { id: true, name: true, fareMode: true, flatFareMinor: true },
      });
      const routeById = new Map(routes.map((r) => [r.id, r]));
      const stopIds = [...new Set(rows.map((r) => r.stopId).filter((s): s is string => !!s))];
      const stops = stopIds.length
        ? await tx.routeStop.findMany({ where: { id: { in: stopIds } }, select: { id: true, name: true, fareMinor: true } })
        : [];
      const stopById = new Map(stops.map((s) => [s.id, s]));
      const passengers = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.passengerId))] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(passengers.map((u) => [u.id, u.name]));
      return rows.map((a) =>
        mapAssignmentDto(
          a,
          routeById.get(a.routeId) ?? null,
          a.stopId ? (stopById.get(a.stopId) ?? null) : null,
          nameById.get(a.passengerId) ?? "",
        ),
      );
    });
  }

  // --- driver relationship scoping (route / vehicle) ------------------------

  /** A driver may only touch their OWN vehicle's routes (404 otherwise). */
  private async assertRouteInScope(tx: TenantTx, p: Principal, routeId: string): Promise<{ vehicleId: string | null }> {
    const route = await tx.transportRoute.findFirst({ where: { id: routeId }, select: { id: true, vehicleId: true } });
    if (!route) throw new NotFoundException("Route not found");
    if (this.moduleWide(p)) return { vehicleId: route.vehicleId };
    const owns = route.vehicleId
      ? await tx.vehicle.findFirst({ where: { id: route.vehicleId, driverId: p.userId }, select: { id: true } })
      : null;
    if (!owns) throw new NotFoundException("Route not found");
    return { vehicleId: route.vehicleId };
  }

  private async assertVehicleInScope(tx: TenantTx, p: Principal, vehicleId: string): Promise<void> {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId }, select: { driverId: true } });
    if (!v) throw new NotFoundException("Vehicle not found");
    if (this.moduleWide(p)) return;
    if (v.driverId !== p.userId) throw new NotFoundException("Vehicle not found");
  }

  // --- trips (AM pickup / PM drop-off schedules) ----------------------------

  async createTrip(
    p: Principal,
    input: { routeId: string; direction: string; name?: string | null; departTime: string; daysOfWeek?: string[] },
  ): Promise<TransportTripDto> {
    if (!/^\d{2}:\d{2}$/.test(input.departTime)) throw new BadRequestException("departTime must be HH:MM");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertRouteInScope(tx, p, input.routeId);
      const row = await tx.transportTrip.create({
        data: {
          schoolId: p.schoolId,
          routeId: input.routeId,
          direction: input.direction,
          name: input.name?.trim() || null,
          departTime: input.departTime,
          daysOfWeek: (input.daysOfWeek ?? ["MON", "TUE", "WED", "THU", "FRI"]) as unknown as Prisma.InputJsonValue,
          status: "ACTIVE",
        },
      });
      await this.log(tx, p, "transport.trip.create", row.id, { routeId: input.routeId, direction: input.direction });
      return this.tripDto(tx, row.id);
    });
  }

  async updateTrip(
    p: Principal,
    id: string,
    input: { name?: string | null; departTime?: string; daysOfWeek?: string[]; status?: string },
  ): Promise<TransportTripDto> {
    if (input.departTime && !/^\d{2}:\d{2}$/.test(input.departTime)) throw new BadRequestException("departTime must be HH:MM");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.transportTrip.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Trip not found");
      await this.assertRouteInScope(tx, p, row.routeId);
      const updated = await tx.transportTrip.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
          ...(input.departTime !== undefined ? { departTime: input.departTime } : {}),
          ...(input.daysOfWeek !== undefined ? { daysOfWeek: input.daysOfWeek as unknown as Prisma.InputJsonValue } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      await this.log(tx, p, "transport.trip.update", id, {});
      return this.tripDto(tx, updated.id);
    });
  }

  async listTrips(p: Principal, routeId?: string): Promise<TransportTripDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (routeId) await this.assertRouteInScope(tx, p, routeId);
      const where: Record<string, unknown> = {};
      if (routeId) where.routeId = routeId;
      else if (!this.moduleWide(p)) {
        const mine = await tx.transportRoute.findMany({ where: { vehicle: { driverId: p.userId } }, select: { id: true } });
        where.routeId = { in: mine.map((r) => r.id) };
      }
      const rows = await tx.transportTrip.findMany({ where, orderBy: [{ direction: "asc" }, { departTime: "asc" }] });
      return this.mapTrips(tx, rows);
    });
  }

  // --- boarding confirmation (child-safety; guardians alerted on pickup) -----

  /** Record a passenger boarding (or alighting). PICKUP notifies the student's
   *  guardians. Idempotent per (passenger, date, direction). A driver may only
   *  record for their own routes; admins/head-driver for any. */
  async recordBoarding(
    p: Principal,
    input: { routeId: string; passengerId: string; direction?: string; date?: string; method?: string; status?: string },
  ): Promise<TransportBoardingDto> {
    const explicitDay = input.date ? new Date(`${input.date}T00:00:00.000Z`) : null;
    if (explicitDay && Number.isNaN(explicitDay.getTime())) throw new BadRequestException("Invalid date");
    const direction = input.direction === "DROPOFF" ? "DROPOFF" : "PICKUP";
    const { dto, notify, passengerType } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertRouteInScope(tx, p, input.routeId);
      // "TODAY" IS THE SCHOOL'S DAY, not the server's.
      //
      // This defaulted to the server's UTC date, and the boarding register is
      // keyed on (passenger, date, direction). A school east of UTC records its
      // morning pickup before UTC midnight — 07:30 in Singapore is 23:30 the
      // PREVIOUS day in UTC — so the run was filed against yesterday, on top of
      // yesterday's row for the same child and direction. One journey
      // overwrites another, and the register for the day a parent asks about is
      // the wrong one. The same rule the class register, the gate scan and the
      // staff clock-in already follow.
      const day = explicitDay ?? schoolToday((await this.region.inTx(tx, p.schoolId)).timezone);
      // The passenger must be assigned to this route.
      const assignment = await tx.transportAssignment.findFirst({
        where: { routeId: input.routeId, passengerId: input.passengerId, status: "ACTIVE" },
        select: { id: true, passengerType: true },
      });
      if (!assignment) throw new BadRequestException("That passenger is not assigned to this route");
      const status = input.status === "ABSENT" ? "ABSENT" : "BOARDED";
      // Alert the guardians only on a FRESH boarding — a re-scan of an already
      // BOARDED passenger is idempotent and must not send a second alert.
      const prior = await tx.transportBoarding.findFirst({
        where: { passengerId: input.passengerId, date: day, direction },
        select: { status: true },
      });
      const alreadyBoarded = prior?.status === "BOARDED";
      const row = await tx.transportBoarding.upsert({
        where: { passengerId_date_direction: { passengerId: input.passengerId, date: day, direction } },
        update: { status, method: input.method === "SCAN" ? "SCAN" : "MANUAL", routeId: input.routeId, recordedById: p.userId, recordedAt: new Date() },
        create: {
          schoolId: p.schoolId,
          routeId: input.routeId,
          passengerId: input.passengerId,
          date: day,
          direction,
          status,
          method: input.method === "SCAN" ? "SCAN" : "MANUAL",
          recordedById: p.userId,
        },
      });
      await this.log(tx, p, "transport.boarding.record", row.id, { routeId: input.routeId, passengerId: input.passengerId, direction, status });
      return {
        dto: await this.boardingDto(tx, row.id),
        notify: status === "BOARDED" && !alreadyBoarded,
        passengerType: assignment.passengerType,
      };
    });
    // Only STUDENT boardings alert guardians; a PICKUP is the safety-critical event.
    if (notify && direction === "PICKUP" && passengerType === "STUDENT") {
      await this.notifyGuardians(p, input.passengerId, "Your child boarded the bus", "Your child has boarded the school bus for pickup.");
    }
    return dto;
  }

  async listBoardings(p: Principal, routeId: string, date: string): Promise<TransportBoardingDto[]> {
    const day = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException("Invalid date");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertRouteInScope(tx, p, routeId);
      const rows = await tx.transportBoarding.findMany({ where: { routeId, date: day }, orderBy: { recordedAt: "asc" } });
      return this.mapBoardings(tx, rows);
    });
  }

  // --- maintenance / fuel log -----------------------------------------------

  async addMaintenance(
    p: Principal,
    input: { vehicleId: string; type: string; date: string; costMinor?: number; odometerKm?: number | null; litres?: number | null; vendor?: string | null; notes?: string | null },
  ): Promise<VehicleMaintenanceDto> {
    const day = new Date(`${input.date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException("Invalid date");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertVehicleInScope(tx, p, input.vehicleId);
      const row = await tx.vehicleMaintenance.create({
        data: {
          schoolId: p.schoolId,
          vehicleId: input.vehicleId,
          type: input.type,
          date: day,
          costMinor: Math.max(0, Math.round(input.costMinor ?? 0)),
          odometerKm: input.odometerKm ?? null,
          litres: input.litres ?? null,
          vendor: input.vendor?.trim() || null,
          notes: input.notes?.trim() || null,
          recordedById: p.userId,
        },
      });
      await this.log(tx, p, "transport.maintenance.add", row.id, { vehicleId: input.vehicleId, type: input.type, costMinor: row.costMinor });
      return this.maintenanceDto(tx, row.id);
    });
  }

  async listMaintenance(p: Principal, vehicleId?: string): Promise<VehicleMaintenanceDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (vehicleId) await this.assertVehicleInScope(tx, p, vehicleId);
      const where: Record<string, unknown> = {};
      if (vehicleId) where.vehicleId = vehicleId;
      else if (!this.moduleWide(p)) {
        const mine = await tx.vehicle.findMany({ where: { driverId: p.userId }, select: { id: true } });
        where.vehicleId = { in: mine.map((v) => v.id) };
      }
      const rows = await tx.vehicleMaintenance.findMany({ where, orderBy: { date: "desc" }, take: 300 });
      return this.mapMaintenance(tx, rows);
    });
  }

  // --- live GPS -------------------------------------------------------------

  /** Ingest a GPS breadcrumb. A driver posts only for their own vehicle. */
  async ingestLocation(
    p: Principal,
    input: { vehicleId: string; lat: number; lng: number; speedKph?: number | null; headingDeg?: number | null },
  ): Promise<{ ok: true }> {
    if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) throw new BadRequestException("Invalid coordinates");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertVehicleInScope(tx, p, input.vehicleId);
      await tx.vehicleLocation.create({
        data: {
          schoolId: p.schoolId,
          vehicleId: input.vehicleId,
          lat: input.lat,
          lng: input.lng,
          speedKph: input.speedKph ?? null,
          headingDeg: input.headingDeg ?? null,
        },
      });
      // Bound the stream on write: drop this vehicle's pings older than the
      // window. Index-backed on (schoolId, vehicleId, recordedAt), so it is a
      // cheap constant cost per ping and the table stays a fixed size instead of
      // growing to millions of rows and dragging the DB down.
      await tx.vehicleLocation.deleteMany({
        where: {
          vehicleId: input.vehicleId,
          recordedAt: { lt: new Date(Date.now() - LOCATION_RETENTION_DAYS * 86_400_000) },
        },
      });
      // High-volume stream — deliberately NOT audited per-ping.
      return { ok: true as const };
    });
  }

  /** Latest known position per vehicle (fleet map). Driver-scoped to own vehicle. */
  async latestLocations(p: Principal): Promise<VehicleLocationDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const vehicles = await tx.vehicle.findMany({
        where: this.moduleWide(p) ? {} : { driverId: p.userId },
        select: { id: true, name: true },
      });
      if (vehicles.length === 0) return [];
      // ONE query for the newest ping per vehicle. The fleet map polls this every
      // few seconds from every open console, so a findFirst-per-vehicle would
      // multiply into constant load; DISTINCT ON rides the
      // (schoolId, vehicleId, recordedAt) index. RLS still scopes the raw read.
      const ids = vehicles.map((v) => v.id);
      const rows = await tx.$queryRaw<
        Array<{ vehicleId: string; lat: number; lng: number; speedKph: number | null; headingDeg: number | null; recordedAt: Date }>
      >`
        SELECT DISTINCT ON ("vehicleId") "vehicleId", lat, lng, "speedKph", "headingDeg", "recordedAt"
        FROM "vehicle_location"
        WHERE "vehicleId" = ANY(${ids}::uuid[])
        ORDER BY "vehicleId", "recordedAt" DESC
      `;
      const nameById = new Map(vehicles.map((v) => [v.id, v.name]));
      return rows.map((r) => ({
        vehicleId: r.vehicleId,
        vehicleName: nameById.get(r.vehicleId) ?? "",
        lat: r.lat,
        lng: r.lng,
        speedKph: r.speedKph,
        headingDeg: r.headingDeg,
        recordedAt: r.recordedAt,
      }));
    });
  }

  // --- fee scheduling (bills through the shared Fees invoice tables) --------

  async scheduleFees(
    p: Principal,
    input: { routeId?: string; dueDate: string; description?: string },
  ): Promise<TransportFeeRunDto | { pendingApproval: true; requestId: string }> {
    const due = new Date(input.dueDate);
    if (Number.isNaN(due.getTime())) throw new BadRequestException("invalid dueDate");
    // MAKER-CHECKER: fare runs post onto student invoices (money), so a head
    // driver's run becomes a FEE_SCHEDULE workflow request approved by a
    // DIFFERENT workflow.review holder; the hook posts it on approval.
    if (!this.wide(p)) {
      const req = (await this.workflow.createRequest(p, {
        type: "FEE_SCHEDULE",
        title: `Transport fee run (${input.routeId ? "one route" : "all routes"}) due ${input.dueDate.slice(0, 10)}`,
        payload: { module: "transport", routeId: input.routeId ?? null, dueDate: input.dueDate, description: input.description ?? null },
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true, requestId: req.id };
    }
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      this.postFeeRun(tx, p.schoolId, p.userId, { routeId: input.routeId, due, description: input.description }),
    );
  }

  /** Post a transport fee run (fares -> invoice line items); direct (admin) or
   *  from the FEE_SCHEDULE approval hook — always inside a tenant tx. */
  private async postFeeRun(
    tx: TenantTx,
    schoolId: string,
    actorId: string,
    input: { routeId?: string; due: Date; description?: string },
  ): Promise<TransportFeeRunDto> {
    {
      const due = input.due;
      const where = input.routeId ? { routeId: input.routeId, status: "ACTIVE" } : { status: "ACTIVE" };
      const assignments = await tx.transportAssignment.findMany({ where });

      // IDEMPOTENCY — same defect and same fix as the hostel run. A fare run
      // posts money onto a passenger's invoice, and a second press or a replayed
      // FEE_SCHEDULE approval charged every passenger again, with no marker to
      // tell the duplicate from the original afterwards.
      const lineDescription = input.description ?? "Transport fare";
      // The SCHOOL's currency, not the column default of NGN: settlement refuses
      // a charge whose currency differs from the invoice, so an invoice raised
      // in the wrong one can never be paid online.
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { currency: true } });
      const schoolCurrency = school?.currency ?? "NGN";
      const passengerIds = (assignments as Array<{ passengerId: string }>).map((a) => a.passengerId);
      const alreadyBilled = passengerIds.length
        ? await tx.invoiceLineItem.findMany({
            where: { description: lineDescription, invoice: { studentId: { in: passengerIds }, status: "DRAFT" } },
            select: { invoice: { select: { studentId: true } } },
          })
        : [];
      const billed = new Set(
        (alreadyBilled as Array<{ invoice: { studentId: string } }>).map((l) => l.invoice.studentId),
      );

      let invoicesCreated = 0;
      let skippedAlreadyBilled = 0;
      let totalBilledMinor = 0;
      let passengersBilled = 0;
      for (const a of assignments as Array<{ routeId: string; stopId: string | null; passengerId: string; passengerType: string }>) {
        if (a.passengerType !== "STUDENT") continue; // only students are invoiced
        const fare = await this.fareFor(tx, a.routeId, a.stopId);
        if (fare <= 0) continue;
        if (billed.has(a.passengerId)) {
          skippedAlreadyBilled++;
          continue;
        }
        billed.add(a.passengerId);
        let invoice = await tx.invoice.findFirst({ where: { studentId: a.passengerId, status: "DRAFT" } });
        if (!invoice) {
          invoice = await tx.invoice.create({
            data: {
              schoolId,
              studentId: a.passengerId,
              createdById: actorId,
              reference: `TRANSPORT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              status: "DRAFT",
              totalMinor: 0,
              currency: schoolCurrency,
              dueDate: due,
            },
          });
          invoicesCreated++;
        }
        await tx.invoiceLineItem.create({
          data: { schoolId, invoiceId: invoice.id, description: lineDescription, amountMinor: fare, quantity: 1 },
        });
        await tx.invoice.update({ where: { id: invoice.id }, data: { totalMinor: { increment: fare } } });
        totalBilledMinor += fare;
        passengersBilled++;
      }
      await this.audit.record(
        { actorId, action: "transport.fees.schedule", entity: "transport", entityId: input.routeId ?? "all", schoolId, metadata: { invoicesCreated, totalBilledMinor, passengersBilled, skippedAlreadyBilled } },
        tx,
      );
      return { invoicesCreated, totalBilledMinor, passengersBilled };
    }
  }

  // --- helpers --------------------------------------------------------------

  private async routeCapacity(tx: TenantTx, vehicleId: string | null): Promise<number> {
    if (!vehicleId) return 0;
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId }, select: { capacity: true } });
    return v?.capacity ?? 0;
  }

  private async fareFor(tx: TenantTx, routeId: string, stopId: string | null): Promise<number> {
    const route = await tx.transportRoute.findFirst({ where: { id: routeId }, select: { fareMode: true, flatFareMinor: true } });
    if (!route) return 0;
    if (route.fareMode === "FLAT") return route.flatFareMinor;
    if (stopId) {
      const stop = await tx.routeStop.findFirst({ where: { id: stopId }, select: { fareMinor: true } });
      return stop?.fareMinor ?? 0;
    }
    return 0;
  }

  private async assertUserInSchool(tx: TenantTx, userId: string): Promise<void> {
    // In this school AND still here. Existing was never the question: a transport
    // duty handed to somebody who has left is a duty nobody is doing.
    await assertStillHere(tx, userId, "User");
  }

  private vehicleDto(v: {
    id: string; name: string; regNumber: string | null; capacity: number; driverId?: string | null; customFields: unknown; createdAt: Date;
  }): VehicleDto {
    return { id: v.id, name: v.name, regNumber: v.regNumber, capacity: v.capacity, driverId: v.driverId ?? null, customFields: this.cf(v.customFields), createdAt: v.createdAt };
  }

  private stopDto(s: {
    id: string; routeId: string; name: string; sequence: number; fareMinor: number; pickupTime: string | null;
  }): RouteStopDto {
    return { id: s.id, routeId: s.routeId, name: s.name, sequence: s.sequence, fareMinor: s.fareMinor, pickupTime: s.pickupTime };
  }

  private async routeDto(tx: TenantTx, routeId: string): Promise<TransportRouteDto> {
    const r = await tx.transportRoute.findFirstOrThrow({ where: { id: routeId } });
    const stops = await tx.routeStop.findMany({ where: { routeId }, orderBy: { sequence: "asc" } });
    const vehicle = r.vehicleId ? await tx.vehicle.findFirst({ where: { id: r.vehicleId }, select: { name: true, capacity: true } }) : null;
    const capacity = vehicle?.capacity ?? 0;
    const seatsUsed = await tx.transportAssignment.count({ where: { routeId, status: "ACTIVE" } });
    return {
      id: r.id,
      name: r.name,
      vehicleId: r.vehicleId,
      vehicleName: vehicle?.name ?? null,
      sessionId: r.sessionId,
      fareMode: r.fareMode,
      flatFareMinor: r.flatFareMinor,
      status: r.status,
      customFields: this.cf(r.customFields),
      stops: stops.map((s) => this.stopDto(s)),
      capacity,
      seatsUsed,
      seatsAvailable: capacity > 0 ? Math.max(0, capacity - seatsUsed) : 0,
      createdAt: r.createdAt,
    };
  }

  private async assignmentDto(tx: TenantTx, id: string): Promise<TransportAssignmentDto> {
    const a = await tx.transportAssignment.findFirstOrThrow({ where: { id } });
    const route = await tx.transportRoute.findFirst({ where: { id: a.routeId }, select: { name: true, fareMode: true, flatFareMinor: true } });
    const stop = a.stopId ? await tx.routeStop.findFirst({ where: { id: a.stopId }, select: { name: true, fareMinor: true } }) : null;
    const passenger = await tx.user.findFirst({ where: { id: a.passengerId }, select: { name: true } });
    return mapAssignmentDto(a, route, stop, passenger?.name ?? "");
  }

  private async tripDto(tx: TenantTx, id: string): Promise<TransportTripDto> {
    const row = await tx.transportTrip.findFirstOrThrow({ where: { id } });
    return (await this.mapTrips(tx, [row]))[0];
  }
  private async mapTrips(tx: TenantTx, rows: Array<Record<string, unknown>>): Promise<TransportTripDto[]> {
    if (rows.length === 0) return [];
    const r = rows as unknown as Array<{ id: string; routeId: string; direction: string; name: string | null; departTime: string; daysOfWeek: unknown; status: string }>;
    const routes = await tx.transportRoute.findMany({ where: { id: { in: [...new Set(r.map((x) => x.routeId))] } }, select: { id: true, name: true } });
    const rName = new Map(routes.map((x) => [x.id, x.name]));
    return r.map((x) => ({
      id: x.id,
      routeId: x.routeId,
      routeName: rName.get(x.routeId) ?? "",
      direction: x.direction,
      name: x.name,
      departTime: x.departTime,
      daysOfWeek: Array.isArray(x.daysOfWeek) ? (x.daysOfWeek as string[]) : [],
      status: x.status,
    }));
  }

  private async boardingDto(tx: TenantTx, id: string): Promise<TransportBoardingDto> {
    const row = await tx.transportBoarding.findFirstOrThrow({ where: { id } });
    return (await this.mapBoardings(tx, [row]))[0];
  }
  private async mapBoardings(tx: TenantTx, rows: Array<Record<string, unknown>>): Promise<TransportBoardingDto[]> {
    if (rows.length === 0) return [];
    const r = rows as unknown as Array<{ id: string; tripId: string | null; routeId: string; passengerId: string; date: Date; direction: string; status: string; method: string; recordedById: string; recordedAt: Date }>;
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(r.map((x) => x.passengerId))] } }, select: { id: true, name: true } });
    const uName = new Map(users.map((u) => [u.id, u.name]));
    return r.map((x) => ({
      id: x.id,
      tripId: x.tripId,
      routeId: x.routeId,
      passengerId: x.passengerId,
      passengerName: uName.get(x.passengerId) ?? "",
      date: x.date,
      direction: x.direction,
      status: x.status,
      method: x.method,
      recordedById: x.recordedById,
      recordedAt: x.recordedAt,
    }));
  }

  private async maintenanceDto(tx: TenantTx, id: string): Promise<VehicleMaintenanceDto> {
    const row = await tx.vehicleMaintenance.findFirstOrThrow({ where: { id } });
    return (await this.mapMaintenance(tx, [row]))[0];
  }
  private async mapMaintenance(tx: TenantTx, rows: Array<Record<string, unknown>>): Promise<VehicleMaintenanceDto[]> {
    if (rows.length === 0) return [];
    const r = rows as unknown as Array<{ id: string; vehicleId: string; type: string; date: Date; costMinor: number; odometerKm: number | null; litres: number | null; vendor: string | null; notes: string | null; recordedById: string; createdAt: Date }>;
    const vehicles = await tx.vehicle.findMany({ where: { id: { in: [...new Set(r.map((x) => x.vehicleId))] } }, select: { id: true, name: true } });
    const vName = new Map(vehicles.map((v) => [v.id, v.name]));
    return r.map((x) => ({
      id: x.id,
      vehicleId: x.vehicleId,
      vehicleName: vName.get(x.vehicleId) ?? "",
      type: x.type,
      date: x.date,
      costMinor: x.costMinor,
      odometerKm: x.odometerKm,
      litres: x.litres,
      vendor: x.vendor,
      notes: x.notes,
      recordedById: x.recordedById,
      createdAt: x.createdAt,
    }));
  }

  /** Best-effort guardian notification (never blocks the caller's action). */
  private async notifyGuardians(p: Principal, studentId: string, title: string, body: string): Promise<void> {
    try {
      const links = await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      for (const l of links as { parentId: string }[]) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: l.parentId,
          type: "TRANSPORT",
          title,
          body,
          data: { studentId },
          channels: ["EMAIL"],
        });
      }
    } catch (err) {
      this.logger.error(`Transport guardian notification failed for ${studentId}: ${String(err)}`);
    }
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "transport", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

/** Pure assignment-row → DTO. Route/stop rows carry the fare fields, so the
 *  passenger's fare (flat route fare, or their stop's fare) is computed here with
 *  no extra query — supporting both the single (assignmentDto) and batched
 *  (listAssignments) paths without a per-row fan-out. */
function mapAssignmentDto(
  a: { id: string; routeId: string; stopId: string | null; passengerId: string; passengerType: string; status: string },
  route: { name: string; fareMode: string; flatFareMinor: number } | null,
  stop: { name: string; fareMinor: number } | null,
  passengerName: string,
): TransportAssignmentDto {
  const fareMinor = !route ? 0 : route.fareMode === "FLAT" ? route.flatFareMinor : (stop?.fareMinor ?? 0);
  return {
    id: a.id,
    routeId: a.routeId,
    routeName: route?.name ?? "",
    stopId: a.stopId,
    stopName: stop?.name ?? null,
    passengerId: a.passengerId,
    passengerName,
    passengerType: a.passengerType,
    status: a.status,
    fareMinor,
  };
}
