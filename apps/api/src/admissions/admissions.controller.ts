import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { AdmissionApplicationDto } from "@sms/types";
import { z } from "zod";
import { ADMISSION_PERMISSIONS } from "@sms/types";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { AdmissionsService } from "./admissions.service";

const detailsSchema = z.object({
  parentName: z.string().min(1).max(200),
  parentEmail: z.string().email(),
  parentPhone: z.string().max(40).nullish(),
  parentAddress: z.string().max(400).nullish(),
  relationship: z.string().max(60).nullish(),
  childName: z.string().min(1).max(200),
  childDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  childGender: z.string().max(20).nullish(),
  desiredClass: z.string().max(80).nullish(),
  priorSchool: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

const submitSchema = z.object({
  schoolSlug: z.string().min(1).max(80),
  applicantName: z.string().min(1).max(200),
  applicantEmail: z.string().email(),
  applicantPhone: z.string().max(40).nullish(),
  childName: z.string().min(1).max(200),
  childDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  desiredClass: z.string().max(80).nullish(),
  notes: z.string().max(2000).nullish(),
  details: detailsSchema.nullish(),
});

const reviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(1000).optional(),
});

const examSchema = z.object({
  examDate: z.string().datetime().nullish(),
  examNote: z.string().max(1000).nullish(),
  desiredClass: z.string().max(80).nullish(),
});

@RequireModule(MODULES.ADMISSIONS)
@Controller()
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  /** PUBLIC application intake. No session; rate-limited in-process (backstop to
   *  the edge WAF rule) since it is an unauthenticated write. */
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("public/admissions")
  submit(@Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>) {
    return this.admissions.submit(body);
  }

  @Get("admissions")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  list(@CurrentPrincipal() p: Principal): Promise<AdmissionApplicationDto[]> {
    return this.admissions.list(p);
  }

  @Get("admissions/:id")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  getOne(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<AdmissionApplicationDto> {
    return this.admissions.get(p, id);
  }

  /** Decide the current maker-checker stage (Admin → HR → Principal). */
  @Post("admissions/:id/review")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.admissions.review(p, id, body.action, body.note);
  }

  /** Schedule / update the entrance exam (communicated to the applicant on acceptance). */
  @Post("admissions/:id/exam")
  @RequirePermission(ADMISSION_PERMISSIONS.ADMISSION_REVIEW)
  setExam(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(examSchema)) body: z.infer<typeof examSchema>,
  ) {
    return this.admissions.setExam(p, id, body);
  }
}
