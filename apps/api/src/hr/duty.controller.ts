// =============================================================================
// DutyController — duty roster (hr.write assigns; hr.read views; hr.self = mine)
// =============================================================================

import { isoDay } from "../common/calendar-day";
import { hhmm } from "../common/time-of-day";
import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type { DutyAssignmentDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DutyService } from "./duty.service";

const assignSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
  dates: z.array(isoDay).min(1).max(31),
  title: z.string().min(1).max(120),
  startTime: hhmm,
  endTime: hhmm,
  note: z.string().max(300).optional(),
});
const rangeSchema = z.object({
  from: isoDay,
  to: isoDay,
});

@RequireModule(MODULES.HR)
@Controller("hr/duty")
export class DutyController {
  constructor(private readonly duty: DutyService) {}

  @Post()
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  assign(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(assignSchema)) b: z.infer<typeof assignSchema>,
  ): Promise<{ created: number }> {
    return this.duty.assign(p, b);
  }

  @Get()
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(rangeSchema)) q: z.infer<typeof rangeSchema>,
  ): Promise<DutyAssignmentDto[]> {
    return this.duty.list(p, q.from, q.to);
  }

  @Get("me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  mine(@CurrentPrincipal() p: Principal): Promise<DutyAssignmentDto[]> {
    return this.duty.mine(p);
  }

  @Delete(":id")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ deleted: boolean }> {
    return this.duty.remove(p, id);
  }
}
