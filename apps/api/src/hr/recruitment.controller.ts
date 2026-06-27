import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { ApplicantDto, JobRequisitionDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { RecruitmentService } from "./recruitment.service";

const reqSchema = z.object({
  title: z.string().min(1).max(160),
  department: z.string().max(120).nullish(),
  description: z.string().max(4000).nullish(),
  openings: z.number().int().min(1).max(999).optional(),
});
const reqStatusSchema = z.object({ status: z.enum(["DRAFT", "OPEN", "CLOSED", "FILLED"]) });
const applicantSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.string().email(),
  phone: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});
const stageSchema = z.object({ stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"]) });
const convertSchema = z.object({ jobTitle: z.string().max(120).optional(), password: z.string().min(8).max(200).optional() });

@RequireModule(MODULES.HR)
@Controller("hr/recruitment")
export class RecruitmentController {
  constructor(private readonly recruit: RecruitmentService) {}

  @Post("requisitions")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  createReq(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(reqSchema)) body: z.infer<typeof reqSchema>,
  ): Promise<JobRequisitionDto> {
    return this.recruit.createRequisition(p, body);
  }

  @Get("requisitions")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  listReqs(@CurrentPrincipal() p: Principal): Promise<JobRequisitionDto[]> {
    return this.recruit.listRequisitions(p);
  }

  @Post("requisitions/:id/status")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  setReqStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reqStatusSchema)) body: z.infer<typeof reqStatusSchema>,
  ): Promise<JobRequisitionDto> {
    return this.recruit.setRequisitionStatus(p, id, body.status);
  }

  @Post("requisitions/:id/applicants")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  addApplicant(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(applicantSchema)) body: z.infer<typeof applicantSchema>,
  ): Promise<ApplicantDto> {
    return this.recruit.addApplicant(p, id, body);
  }

  @Get("applicants")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  listApplicants(@CurrentPrincipal() p: Principal, @Query("requisitionId") requisitionId?: string): Promise<ApplicantDto[]> {
    return this.recruit.listApplicants(p, requisitionId);
  }

  @Post("applicants/:id/stage")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  moveStage(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(stageSchema)) body: z.infer<typeof stageSchema>,
  ): Promise<ApplicantDto> {
    return this.recruit.moveStage(p, id, body.stage);
  }

  /** Convert a hired applicant into a staff account (creates credentials → step-up). */
  @Post("applicants/:id/convert")
  @RequirePermission(HR_PERMISSIONS.HR_RECRUIT_MANAGE)
  @RequireStepUp()
  convert(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(convertSchema)) body: z.infer<typeof convertSchema>,
  ): Promise<{ userId: string; email: string; tempPassword: string }> {
    return this.recruit.convert(p, id, body);
  }
}
