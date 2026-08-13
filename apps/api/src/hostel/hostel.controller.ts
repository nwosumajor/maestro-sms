import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { HOSTEL_PERMISSIONS, MODULES } from "@sms/types";
import type {
  HostelAllocationDto,
  HostelAttendanceDto,
  HostelDto,
  HostelExeatDto,
  HostelFeeRunDto,
  HostelIncidentDto,
  HostelRoomDto,
  HostelSummaryDto,
} from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { HostelService } from "./hostel.service";
import { ExeatOverdueService } from "./exeat-overdue.service";
import { JobRunsService } from "../maintenance/job-runs.service";

const customFields = z.record(z.string()).optional();
const hostelSchema = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(["BOYS", "GIRLS", "MIXED"]).default("MIXED"),
  wardenId: z.string().uuid().nullish(),
  customFields,
});
const hostelUpdateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  type: z.enum(["BOYS", "GIRLS", "MIXED"]).optional(),
  wardenId: z.string().uuid().nullish(),
  customFields,
});
const roomSchema = z.object({
  roomNumber: z.string().min(1).max(40),
  roomType: z.string().min(1).max(40).default("SHARED"),
  capacity: z.number().int().min(1).max(100),
  rentMinor: z.number().int().min(0),
  customFields,
});
const roomUpdateSchema = z.object({
  roomNumber: z.string().min(1).max(40).optional(),
  roomType: z.string().min(1).max(40).optional(),
  capacity: z.number().int().min(1).max(100).optional(),
  rentMinor: z.number().int().min(0).optional(),
  customFields,
});
const allocateSchema = z.object({ roomId: z.string().uuid(), studentId: z.string().uuid() });
const transferSchema = z.object({ studentId: z.string().uuid(), toRoomId: z.string().uuid(), reason: z.string().max(300).optional() });
const feeSchema = z.object({
  hostelId: z.string().uuid().optional(),
  dueDate: z.string(),
  description: z.string().max(200).optional(),
});
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rollCallSchema = z.object({
  date: isoDay,
  records: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.enum(["PRESENT", "ABSENT", "EXEAT", "SICK", "LATE"]),
        note: z.string().max(300).nullish(),
      }),
    )
    .max(1000),
});
const exeatSchema = z.object({
  studentId: z.string().uuid(),
  reason: z.string().min(1).max(300),
  destination: z.string().max(200).nullish(),
  departAt: z.string(),
  expectedReturnAt: z.string(),
});
const exeatDecideSchema = z.object({ approve: z.boolean(), note: z.string().max(300).optional() });
const incidentSchema = z.object({
  hostelId: z.string().uuid(),
  roomId: z.string().uuid().nullish(),
  category: z.enum(["MAINTENANCE", "DISCIPLINE", "HEALTH", "SECURITY", "OTHER"]).default("MAINTENANCE"),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
});
const incidentUpdateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
  resolutionNote: z.string().max(2000).nullish(),
});

@RequireModule(MODULES.HOSTEL)
@Controller("hostels")
export class HostelController {
  constructor(
    private readonly jobRuns: JobRunsService,
    private readonly hostel: HostelService,
    private readonly overdue: ExeatOverdueService,
  ) {}

  @Get()
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  list(@CurrentPrincipal() p: Principal): Promise<HostelDto[]> {
    return this.hostel.listHostels(p);
  }

  /** Occupancy analytics (warden-scoped or school-wide). */
  @Get("summary")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  summary(@CurrentPrincipal() p: Principal): Promise<HostelSummaryDto> {
    return this.hostel.summary(p);
  }

  @Post()
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(hostelSchema)) body: z.infer<typeof hostelSchema>,
  ): Promise<HostelDto> {
    return this.hostel.createHostel(p, body);
  }

  @Put(":id")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(hostelUpdateSchema)) body: z.infer<typeof hostelUpdateSchema>,
  ): Promise<HostelDto> {
    return this.hostel.updateHostel(p, id, body);
  }

  /** Delete an EMPTY hostel (admin-only; 409 with the reason while rooms exist). */
  @Delete(":id")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  deleteHostel(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.hostel.deleteHostel(p, id);
  }

  /** Delete a room with no allocation history (409 with the reason otherwise). */
  @Delete("rooms/:roomId")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  deleteRoom(@CurrentPrincipal() p: Principal, @Param("roomId") roomId: string) {
    return this.hostel.deleteRoom(p, roomId);
  }

  @Post(":id/rooms")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  createRoom(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(roomSchema)) body: z.infer<typeof roomSchema>,
  ): Promise<HostelRoomDto> {
    return this.hostel.createRoom(p, id, body);
  }

  @Put("rooms/:roomId")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  updateRoom(
    @CurrentPrincipal() p: Principal,
    @Param("roomId") roomId: string,
    @Body(new ZodValidationPipe(roomUpdateSchema)) body: z.infer<typeof roomUpdateSchema>,
  ): Promise<HostelRoomDto> {
    return this.hostel.updateRoom(p, roomId, body);
  }

  @Get("allocations")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  allocations(
    @CurrentPrincipal() p: Principal,
    @Query("hostelId") hostelId?: string,
    @Query("q") q?: string,
  ): Promise<HostelAllocationDto[]> {
    return this.hostel.listAllocations(p, hostelId, q);
  }

  @Post("allocations")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  allocate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(allocateSchema)) body: z.infer<typeof allocateSchema>,
  ): Promise<HostelAllocationDto> {
    return this.hostel.allocate(p, body.roomId, body.studentId);
  }

  /**
   * Run the overdue-boarder check now.
   *
   * The hourly sweep is the mechanism; this exists because a scheduled job
   * nobody can trigger is a job nobody can verify — the same lesson the billing
   * dunning sweep taught. Reports what it FOUND as well as what it alerted on.
   */
  @Post("exeats/overdue/run")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  runOverdueCheck(): Promise<{ scanned: number; alerted: number }> {
    return this.jobRuns.record("hostel.exeatOverdue", "MANUAL", () =>
      this.overdue.sweep(),
    );
  }

  @Post("allocations/:id/vacate")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  vacate(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HostelAllocationDto> {
    return this.hostel.vacate(p, id);
  }

  /** Move a student to another room (vacate + re-allocate, atomically). */
  @Post("allocations/transfer")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  transfer(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(transferSchema)) body: z.infer<typeof transferSchema>,
  ): Promise<HostelAllocationDto> {
    return this.hostel.transferAllocation(p, body.studentId, body.toRoomId, body.reason);
  }

  // --- roll-call / boarding attendance ---
  @Get(":hostelId/attendance")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  attendance(
    @CurrentPrincipal() p: Principal,
    @Param("hostelId") hostelId: string,
    @Query("date") date: string,
  ): Promise<HostelAttendanceDto[]> {
    return this.hostel.listAttendance(p, hostelId, date);
  }

  @Post(":hostelId/attendance")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  rollCall(
    @CurrentPrincipal() p: Principal,
    @Param("hostelId") hostelId: string,
    @Body(new ZodValidationPipe(rollCallSchema)) body: z.infer<typeof rollCallSchema>,
  ) {
    return this.hostel.rollCall(p, hostelId, body.date, body.records);
  }

  // --- exeat / gate-pass ---
  @Get("exeats")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  exeats(
    @CurrentPrincipal() p: Principal,
    @Query("hostelId") hostelId?: string,
    @Query("status") status?: string,
  ): Promise<HostelExeatDto[]> {
    return this.hostel.listExeats(p, { hostelId, status });
  }

  @Post("exeats")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  requestExeat(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(exeatSchema)) body: z.infer<typeof exeatSchema>,
  ): Promise<HostelExeatDto> {
    return this.hostel.requestExeat(p, body);
  }

  @Post("exeats/:id/decide")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  decideExeat(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(exeatDecideSchema)) body: z.infer<typeof exeatDecideSchema>,
  ): Promise<HostelExeatDto> {
    return this.hostel.decideExeat(p, id, body.approve, body.note);
  }

  @Post("exeats/:id/depart")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  departExeat(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HostelExeatDto> {
    return this.hostel.setExeatMovement(p, id, "DEPARTED");
  }

  @Post("exeats/:id/return")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  returnExeat(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HostelExeatDto> {
    return this.hostel.setExeatMovement(p, id, "RETURNED");
  }

  // --- maintenance / incident log ---
  @Get("incidents")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_READ)
  incidents(
    @CurrentPrincipal() p: Principal,
    @Query("hostelId") hostelId?: string,
    @Query("status") status?: string,
  ): Promise<HostelIncidentDto[]> {
    return this.hostel.listIncidents(p, { hostelId, status });
  }

  @Post("incidents")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  reportIncident(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(incidentSchema)) body: z.infer<typeof incidentSchema>,
  ): Promise<HostelIncidentDto> {
    return this.hostel.reportIncident(p, body);
  }

  @Put("incidents/:id")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  updateIncident(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(incidentUpdateSchema)) body: z.infer<typeof incidentUpdateSchema>,
  ): Promise<HostelIncidentDto> {
    return this.hostel.updateIncident(p, id, body);
  }

  /** Schedule hostel rent as invoice line items (collects alongside academic fees). */
  @Post("fees/schedule")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  scheduleFees(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(feeSchema)) body: z.infer<typeof feeSchema>,
  ): Promise<HostelFeeRunDto | { pendingApproval: true; requestId: string }> {
    return this.hostel.scheduleFees(p, body);
  }
}
