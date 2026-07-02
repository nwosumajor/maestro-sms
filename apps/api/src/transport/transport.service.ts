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
import type {
  RouteStopDto,
  TransportAssignmentDto,
  TransportFeeRunDto,
  TransportRouteDto,
  TransportSummaryDto,
  VehicleDto,
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
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { NotificationService } from "../notifications/notification.service";

type Json = Record<string, string>;

@Injectable()
export class TransportService {
  private readonly logger = new Logger("Transport");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
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
  // school_admin / principal (and an impersonating super_admin) see the whole fleet;
  // a driver sees ONLY their own vehicle + its routes + passengers.
  private wide(p: Principal): boolean {
    return p.roles.some((r) => r === "school_admin" || r === "principal" || r === "super_admin");
  }
  /** Module-wide scoping: admins AND the head driver see/manage the whole fleet.
   *  Structural acts (delete vehicle) stay wide()-only; fee runs are
   *  maker-checker for everyone below wide(). */
  private moduleWide(p: Principal): boolean {
    return this.wide(p) || p.roles.includes("head_driver");
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
    input: { name: string; sequence: number; fareMinor: number; pickupTime?: string | null },
  ): Promise<RouteStopDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const route = await tx.transportRoute.findFirst({ where: { id: routeId }, select: { id: true } });
      if (!route) throw new NotFoundException("Route not found");
      const s = await tx.routeStop.create({
        data: {
          schoolId: p.schoolId,
          routeId,
          name: input.name,
          sequence: input.sequence,
          fareMinor: input.fareMinor,
          pickupTime: input.pickupTime ?? null,
        },
      });
      await this.log(tx, p, "transport.stop.create", s.id, { routeId, name: input.name });
      return this.stopDto(s);
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
      const capacity = await this.routeCapacity(tx, route.vehicleId);
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
      return Promise.all(rows.map((a: { id: string }) => this.assignmentDto(tx, a.id)));
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
      let invoicesCreated = 0;
      let totalBilledMinor = 0;
      let passengersBilled = 0;
      for (const a of assignments as Array<{ routeId: string; stopId: string | null; passengerId: string; passengerType: string }>) {
        if (a.passengerType !== "STUDENT") continue; // only students are invoiced
        const fare = await this.fareFor(tx, a.routeId, a.stopId);
        if (fare <= 0) continue;
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
              dueDate: due,
            },
          });
          invoicesCreated++;
        }
        await tx.invoiceLineItem.create({
          data: { schoolId, invoiceId: invoice.id, description: input.description ?? "Transport fare", amountMinor: fare, quantity: 1 },
        });
        await tx.invoice.update({ where: { id: invoice.id }, data: { totalMinor: { increment: fare } } });
        totalBilledMinor += fare;
        passengersBilled++;
      }
      await this.audit.record(
        { actorId, action: "transport.fees.schedule", entity: "transport", entityId: input.routeId ?? "all", schoolId, metadata: { invoicesCreated, totalBilledMinor, passengersBilled } },
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
    const u = await tx.user.findFirst({ where: { id: userId }, select: { id: true } });
    if (!u) throw new NotFoundException("User not found in this school");
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
    const route = await tx.transportRoute.findFirstOrThrow({ where: { id: a.routeId }, select: { name: true } });
    const stop = a.stopId ? await tx.routeStop.findFirst({ where: { id: a.stopId }, select: { name: true } }) : null;
    const passenger = await tx.user.findFirst({ where: { id: a.passengerId }, select: { name: true } });
    const fareMinor = await this.fareFor(tx, a.routeId, a.stopId);
    return {
      id: a.id,
      routeId: a.routeId,
      routeName: route.name,
      stopId: a.stopId,
      stopName: stop?.name ?? null,
      passengerId: a.passengerId,
      passengerName: passenger?.name ?? "",
      passengerType: a.passengerType,
      status: a.status,
      fareMinor,
    };
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "transport", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
