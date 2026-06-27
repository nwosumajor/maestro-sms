import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { LeaveBalanceDto, LeaveRequestDto, LeaveTypeDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LeaveService } from "./leave.service";

const typeSchema = z.object({
  name: z.string().min(1).max(80),
  daysPerYear: z.number().int().min(0).max(365),
  active: z.boolean().optional(),
});
const requestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Fractional leave in 0.5-day steps (half-day support).
  days: z.number().min(0.5).max(365).refine((d) => Number.isInteger(d * 2), "days must be in 0.5 increments"),
  reason: z.string().max(500).nullish(),
  attachmentDocId: z.string().uuid().nullish(),
});

@RequireModule(MODULES.HR)
@Controller("hr/leave")
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  // --- self-service (any staff who can raise workflow requests) -------------
  @Get("types")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  listTypes(@CurrentPrincipal() p: Principal): Promise<LeaveTypeDto[]> {
    return this.leave.listLeaveTypes(p);
  }

  @Get("balances/me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myBalances(@CurrentPrincipal() p: Principal): Promise<LeaveBalanceDto[]> {
    return this.leave.myBalances(p);
  }

  @Post("requests")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  request(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(requestSchema)) body: z.infer<typeof requestSchema>,
  ): Promise<LeaveRequestDto> {
    return this.leave.requestLeave(p, body);
  }

  @Get("requests/me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myRequests(@CurrentPrincipal() p: Principal): Promise<LeaveRequestDto[]> {
    return this.leave.myRequests(p);
  }

  // --- management (HR) -------------------------------------------------------
  @Post("types")
  @RequirePermission(HR_PERMISSIONS.HR_LEAVE_MANAGE)
  createType(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(typeSchema)) body: z.infer<typeof typeSchema>,
  ): Promise<LeaveTypeDto> {
    return this.leave.createLeaveType(p, body);
  }

  @Get("requests")
  @RequirePermission(HR_PERMISSIONS.HR_LEAVE_MANAGE)
  allRequests(@CurrentPrincipal() p: Principal): Promise<LeaveRequestDto[]> {
    return this.leave.listRequests(p);
  }

  @Get("calendar")
  @RequirePermission(HR_PERMISSIONS.HR_LEAVE_MANAGE)
  calendar(
    @CurrentPrincipal() p: Principal,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<LeaveRequestDto[]> {
    return this.leave.calendar(p, from, to);
  }
}
