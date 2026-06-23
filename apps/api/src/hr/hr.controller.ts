import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { z } from "zod";
import { HR_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { HrService } from "./hr.service";

const employeeSchema = z.object({
  jobTitle: z.string().min(1).max(120),
  department: z.string().max(120).nullish(),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  salaryMinor: z.number().int().min(0).nullish(),
  status: z.string().max(40).optional(),
});

@Controller("hr")
export class HrController {
  constructor(private readonly hr: HrService) {}

  @Get("employees")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(@CurrentPrincipal() p: Principal) {
    return this.hr.listEmployees(p);
  }

  @Get("employees/:userId")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  get(@CurrentPrincipal() p: Principal, @Param("userId") userId: string) {
    return this.hr.getEmployee(p, userId);
  }

  @Put("employees/:userId")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  upsert(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(employeeSchema)) body: z.infer<typeof employeeSchema>,
  ) {
    return this.hr.upsertEmployee(p, userId, body);
  }
}
