import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { EmployeeDto, SelfProfileDto } from "@sms/types";
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
  tin: z.string().max(40).nullish(),
  rsaPin: z.string().max(40).nullish(),
  gradeLevel: z.string().max(40).nullish(),
  probationMonths: z.number().int().min(1).max(24).optional(),
  managerId: z.string().uuid().nullish(),
});

const selfProfileSchema = z.object({
  phone: z.string().max(40).nullish(),
  address: z.string().max(300).nullish(),
  nextOfKin: z.string().max(160).nullish(),
  nextOfKinPhone: z.string().max(40).nullish(),
  bankName: z.string().max(120).nullish(),
  bankAccount: z.string().max(40).nullish(),
});

@RequireModule(MODULES.HR)
@Controller("hr")
export class HrController {
  constructor(private readonly hr: HrService) {}

  // --- self-service (any staff member, their OWN record) --------------------
  @Get("me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myProfile(@CurrentPrincipal() p: Principal): Promise<SelfProfileDto> {
    return this.hr.getMyProfile(p);
  }

  @Put("me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  updateMyProfile(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(selfProfileSchema)) body: z.infer<typeof selfProfileSchema>,
  ): Promise<SelfProfileDto> {
    return this.hr.updateMyProfile(p, body);
  }

  /** NDPR data-subject ACCESS: export all of my own HR data. */
  @Get("me/export")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  exportMyData(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    return this.hr.exportMyData(p);
  }

  /** NDPR ERASURE of self-service personal/bank fields (employment record retained). */
  @Post("me/erase-personal")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  erasePersonal(@CurrentPrincipal() p: Principal): Promise<{ erased: boolean }> {
    return this.hr.eraseMyPersonal(p);
  }

  @Get("org")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  org(@CurrentPrincipal() p: Principal) {
    return this.hr.org(p);
  }

  @Get("employees")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(@CurrentPrincipal() p: Principal): Promise<EmployeeDto[]> {
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
