import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { AdmissionApplicationDto } from "@sms/types";
import { z } from "zod";
import { ADMISSION_PERMISSIONS } from "@sms/types";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AdmissionsService } from "./admissions.service";

const submitSchema = z.object({
  schoolSlug: z.string().min(1).max(80),
  applicantName: z.string().min(1).max(200),
  applicantEmail: z.string().email(),
  applicantPhone: z.string().max(40).nullish(),
  childName: z.string().min(1).max(200),
  childDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(2000).nullish(),
});
const statusSchema = z.object({
  status: z.enum(["NEW", "REVIEWING", "ACCEPTED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

@RequireModule(MODULES.ADMISSIONS)
@Controller()
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  /** PUBLIC application intake. No session; rate-limit at the edge in production. */
  @Public()
  @Post("public/admissions")
  submit(@Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>) {
    return this.admissions.submit(body);
  }

  @Get("admissions")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  list(@CurrentPrincipal() p: Principal): Promise<AdmissionApplicationDto[]> {
    return this.admissions.list(p);
  }

  @Post("admissions/:id/status")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: { status: "NEW" | "REVIEWING" | "ACCEPTED" | "REJECTED"; note?: string },
  ) {
    return this.admissions.updateStatus(p, id, body.status, body.note);
  }
}
