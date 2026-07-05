// =============================================================================
// ScholarshipController — applicant (parent/teacher) + platform owner surfaces
// =============================================================================
// ALWAYS-ON (no @RequireModule): the scholarship is a platform growth lever, open
// to every school regardless of subscription tier. Applicant endpoints are gated
// by `scholarship.apply` + relationship scoping in the service; platform endpoints
// by `scholarship.admin` (super_admin). Money-moving actions (award, program CRUD)
// are step-up gated.
// =============================================================================

import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { SCHOLARSHIP_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ScholarshipService } from "./scholarship.service";
import { ScholarshipAdminService } from "./scholarship-admin.service";

const uuid = z.string().uuid();
const applySchema = z.object({ programId: uuid, studentId: uuid, answers: z.unknown().optional() });
const answersSchema = z.object({ answers: z.unknown().optional() });
const programSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  budgetMinor: z.number().int().min(0),
  awardMinor: z.number().int().positive(),
  awardKind: z.enum(["FEES_CREDIT", "SUBSCRIPTION_CREDIT"]).optional(),
  selectionBasis: z.enum(["MERIT", "NEED", "BOTH"]).optional(),
  eligibility: z.unknown().optional(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  status: z.enum(["DRAFT", "OPEN", "CLOSED", "ARCHIVED"]).optional(),
});
const programUpdateSchema = programSchema.partial();
const reviewSchema = z.object({ action: z.enum(["REVIEW", "SHORTLIST", "REJECT"]), note: z.string().max(2000).optional() });
const awardSchema = z.object({ awardMinor: z.number().int().positive().optional(), note: z.string().max(2000).optional() });

@Controller("scholarships")
export class ScholarshipController {
  constructor(
    private readonly scholarships: ScholarshipService,
    private readonly admin: ScholarshipAdminService,
  ) {}

  // --- applicant (parent / teacher) ------------------------------------------
  /** Open programs + students I can apply for + my applications. */
  @Get("portal")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  portal(@CurrentPrincipal() p: Principal) {
    return this.scholarships.getPortal(p);
  }

  @Post("applications")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  apply(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(applySchema)) body: z.infer<typeof applySchema>,
  ) {
    return this.scholarships.apply(p, body);
  }

  @Put("applications/:id")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  updateAnswers(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(answersSchema)) body: z.infer<typeof answersSchema>,
  ) {
    return this.scholarships.updateAnswers(p, id, body.answers ?? null);
  }

  /** Guardian consent — required before submission (Golden Rule #5). */
  @Post("applications/:id/consent")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  consent(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.scholarships.consent(p, id);
  }

  @Post("applications/:id/submit")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.APPLY)
  submit(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.scholarships.submit(p, id);
  }

  // --- platform owner (super_admin) ------------------------------------------
  @Get("programs")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  listPrograms() {
    return this.admin.listPrograms();
  }

  @Post("programs")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  createProgram(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(programSchema)) body: z.infer<typeof programSchema>,
  ) {
    return this.admin.createProgram(p, body);
  }

  @Put("programs/:id")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  updateProgram(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(programUpdateSchema)) body: z.infer<typeof programUpdateSchema>,
  ) {
    return this.admin.updateProgram(p, id, body);
  }

  /** Cross-tenant review queue (non-DRAFT applications across all schools). */
  @Get("applications")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  listApplications(
    @CurrentPrincipal() _p: Principal,
    @Query("status") status?: string,
    @Query("programId") programId?: string,
  ) {
    return this.admin.listApplications({ status, programId });
  }

  /** Non-award decisions: REVIEW / SHORTLIST / REJECT. */
  @Post("applications/:id/review")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.admin.decide(p, id, body);
  }

  /** AWARD — disburses a fees credit; step-up (money moves). */
  @Post("applications/:id/award")
  @RequirePermission(SCHOLARSHIP_PERMISSIONS.ADMIN)
  @RequireStepUp()
  award(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(awardSchema)) body: z.infer<typeof awardSchema>,
  ) {
    return this.admin.decide(p, id, { action: "AWARD", ...body });
  }
}
