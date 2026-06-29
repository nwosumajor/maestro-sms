import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { MODULES, INTEGRITY_PERMISSIONS } from "@sms/types";
import type { AssessmentSubmissionDto, AssessmentSummaryDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "./integrity.foundation";
import { AssessmentListService } from "./assessment-list.service";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  classId: z.string().uuid().nullish(),
  integrityEnabled: z.boolean().optional(),
  pasteBlocked: z.boolean().optional(),
  focusTracked: z.boolean().optional(),
  typingTracked: z.boolean().optional(),
  fileUploadEnabled: z.boolean().optional(),
});
const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  integrityEnabled: z.boolean().optional(),
  pasteBlocked: z.boolean().optional(),
  focusTracked: z.boolean().optional(),
  typingTracked: z.boolean().optional(),
  fileUploadEnabled: z.boolean().optional(),
});

/** Index + drill-down for the Assessments section. Relationship-scoped in the
 *  service; module-gated + permission-gated here. */
@RequireModule(MODULES.INTEGRITY)
@Controller("assessments")
export class AssessmentListController {
  constructor(private readonly assessments: AssessmentListService) {}

  @Get()
  @RequirePermission(INTEGRITY_PERMISSIONS.ASSESSMENT_READ)
  list(@CurrentPrincipal() p: Principal): Promise<AssessmentSummaryDto[]> {
    return this.assessments.listAssessments(p);
  }

  /** Create an assessment/assignment (teacher of the class / school-wide). */
  @Post()
  @RequirePermission(INTEGRITY_PERMISSIONS.ASSESSMENT_WRITE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<AssessmentSummaryDto> {
    return this.assessments.createAssessment(p, body);
  }

  /** Update metadata + toggles, incl. enabling/disabling file-upload submissions. */
  @Put(":assessmentId")
  @RequirePermission(INTEGRITY_PERMISSIONS.ASSESSMENT_WRITE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("assessmentId") assessmentId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<AssessmentSummaryDto> {
    return this.assessments.updateAssessment(p, assessmentId, body);
  }

  @Get(":assessmentId/submissions")
  @RequirePermission(INTEGRITY_PERMISSIONS.REPORT_READ)
  submissions(
    @CurrentPrincipal() p: Principal,
    @Param("assessmentId") assessmentId: string,
  ): Promise<AssessmentSubmissionDto[]> {
    return this.assessments.listSubmissions(p, assessmentId);
  }
}
