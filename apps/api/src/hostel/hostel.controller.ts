import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { HOSTEL_PERMISSIONS, MODULES } from "@sms/types";
import type { HostelAllocationDto, HostelDto, HostelFeeRunDto, HostelRoomDto, HostelSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { HostelService } from "./hostel.service";

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
const feeSchema = z.object({
  hostelId: z.string().uuid().optional(),
  dueDate: z.string(),
  description: z.string().max(200).optional(),
});

@RequireModule(MODULES.HOSTEL)
@Controller("hostels")
export class HostelController {
  constructor(private readonly hostel: HostelService) {}

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
  ): Promise<HostelAllocationDto[]> {
    return this.hostel.listAllocations(p, hostelId);
  }

  @Post("allocations")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  allocate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(allocateSchema)) body: z.infer<typeof allocateSchema>,
  ): Promise<HostelAllocationDto> {
    return this.hostel.allocate(p, body.roomId, body.studentId);
  }

  @Post("allocations/:id/vacate")
  @RequirePermission(HOSTEL_PERMISSIONS.HOSTEL_MANAGE)
  vacate(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<HostelAllocationDto> {
    return this.hostel.vacate(p, id);
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
