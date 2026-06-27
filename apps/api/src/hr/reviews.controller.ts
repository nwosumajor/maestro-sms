import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS, WORKFLOW_PERMISSIONS } from "@sms/types";
import type { AppraisalDto, DisciplinaryCaseDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { HrReviewsService } from "./reviews.service";

const createAppraisalSchema = z.object({
  period: z.string().min(1).max(40),
  reviewerId: z.string().uuid().optional(),
  overallRating: z.number().int().min(1).max(5).nullish(),
  summary: z.string().max(4000).nullish(),
  goals: z.string().max(4000).nullish(),
});
const updateAppraisalSchema = z.object({
  period: z.string().min(1).max(40).optional(),
  overallRating: z.number().int().min(1).max(5).nullish(),
  summary: z.string().max(4000).nullish(),
  goals: z.string().max(4000).nullish(),
});
const openCaseSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().max(80).nullish(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});
const entrySchema = z.object({ note: z.string().min(1).max(4000) });
const statusSchema = z.object({ status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]) });

@RequireModule(MODULES.HR)
@Controller("hr")
export class HrReviewsController {
  constructor(private readonly reviews: HrReviewsService) {}

  // --- appraisals (manage) ---------------------------------------------------
  @Post("staff/:userId/appraisals")
  @RequirePermission(HR_PERMISSIONS.HR_APPRAISAL_MANAGE)
  createAppraisal(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(createAppraisalSchema)) body: z.infer<typeof createAppraisalSchema>,
  ): Promise<AppraisalDto> {
    return this.reviews.createAppraisal(p, userId, body);
  }

  @Put("appraisals/:id")
  @RequirePermission(HR_PERMISSIONS.HR_APPRAISAL_MANAGE)
  updateAppraisal(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateAppraisalSchema)) body: z.infer<typeof updateAppraisalSchema>,
  ): Promise<AppraisalDto> {
    return this.reviews.updateAppraisal(p, id, body);
  }

  @Post("appraisals/:id/submit")
  @RequirePermission(HR_PERMISSIONS.HR_APPRAISAL_MANAGE)
  submitAppraisal(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<AppraisalDto> {
    return this.reviews.submitAppraisal(p, id);
  }

  @Get("appraisals")
  @RequirePermission(HR_PERMISSIONS.HR_APPRAISAL_MANAGE)
  listAppraisals(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<AppraisalDto[]> {
    return this.reviews.listAppraisals(p, userId);
  }

  // --- appraisals (self-service: appraisee) ----------------------------------
  @Get("appraisals/me")
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  myAppraisals(@CurrentPrincipal() p: Principal): Promise<AppraisalDto[]> {
    return this.reviews.myAppraisals(p);
  }

  @Post("appraisals/:id/acknowledge")
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  acknowledge(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<AppraisalDto> {
    return this.reviews.acknowledgeAppraisal(p, id);
  }

  // --- disciplinary ----------------------------------------------------------
  @Post("staff/:userId/disciplinary")
  @RequirePermission(HR_PERMISSIONS.HR_DISCIPLINARY_MANAGE)
  openCase(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(openCaseSchema)) body: z.infer<typeof openCaseSchema>,
  ): Promise<DisciplinaryCaseDto> {
    return this.reviews.openCase(p, userId, body);
  }

  @Post("disciplinary/:id/entries")
  @RequirePermission(HR_PERMISSIONS.HR_DISCIPLINARY_MANAGE)
  addEntry(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(entrySchema)) body: z.infer<typeof entrySchema>,
  ): Promise<DisciplinaryCaseDto> {
    return this.reviews.addEntry(p, id, body.note);
  }

  @Post("disciplinary/:id/status")
  @RequirePermission(HR_PERMISSIONS.HR_DISCIPLINARY_MANAGE)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ): Promise<DisciplinaryCaseDto> {
    return this.reviews.setCaseStatus(p, id, body.status);
  }

  @Get("disciplinary")
  @RequirePermission(HR_PERMISSIONS.HR_DISCIPLINARY_MANAGE)
  listCases(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<DisciplinaryCaseDto[]> {
    return this.reviews.listCases(p, userId);
  }
}
