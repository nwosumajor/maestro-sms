import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { GradebookService } from "./gradebook.service";

const gradeSchema = z.object({
  score: z.number().nonnegative(),
  maxScore: z.number().positive(),
  feedback: z.string().max(10_000).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
});

@Controller()
export class GradebookController {
  constructor(private readonly gradebook: GradebookService) {}

  /** Teacher (of the class) / school_admin grades a submission. */
  @Post("submissions/:submissionId/grade")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  grade(
    @CurrentPrincipal() p: Principal,
    @Param("submissionId") submissionId: string,
    @Body(new ZodValidationPipe(gradeSchema))
    body: { score: number; maxScore: number; feedback?: string; status?: "DRAFT" | "PUBLISHED" },
  ) {
    return this.gradebook.gradeSubmission(p, submissionId, body);
  }

  /** Scoped read: teacher/admin see any; student own+published; parent child+published. */
  @Get("submissions/:submissionId/grade")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  getGrade(@CurrentPrincipal() p: Principal, @Param("submissionId") submissionId: string) {
    return this.gradebook.getSubmissionGrade(p, submissionId);
  }

  /** A student's / parent's own published grades. */
  @Get("grades/mine")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  myGrades(@CurrentPrincipal() p: Principal) {
    return this.gradebook.listMyGrades(p);
  }
}
