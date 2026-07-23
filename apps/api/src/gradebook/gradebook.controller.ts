import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS, gradeComponentMax, type GradeComponentKey } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { LMS_PERMISSIONS } from "@sms/types";
import type { Principal } from "../integrity/integrity.foundation";
import { GradebookService } from "./gradebook.service";
import { TermResultService } from "./term-result.service";
import { SubjectSelectionService } from "./subject-selection.service";

const gradeSchema = z.object({
  score: z.number().nonnegative(),
  maxScore: z.number().positive(),
  feedback: z.string().max(10_000).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
});

const uuid = z.string().uuid();
const rosterQuerySchema = z.object({ classId: uuid, subjectId: uuid, termId: uuid });
// Each component is a raw mark bounded by ITS OWN maximum (the service re-validates
// as defense in depth). Maxima come from the single GRADE_COMPONENTS source.
const markField = (key: GradeComponentKey) => z.number().min(0).max(gradeComponentMax(key)).nullish();
const upsertResultSchema = z.object({
  termId: uuid,
  classId: uuid,
  subjectId: uuid,
  studentId: uuid,
  exam: markField("exam"),
  midterm: markField("midterm"),
  assignment: markField("assignment"),
  classNote: markField("classNote"),
});
const publishSchema = z.object({ classId: uuid, subjectId: uuid, termId: uuid });
const broadsheetQuerySchema = z.object({ classId: uuid, termId: uuid });
const selectionSubmitSchema = z.object({
  termId: uuid,
  subjectIds: z.array(uuid).min(1).max(30),
});
const selectionReviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(1000).optional(),
});

@RequireModule(MODULES.GRADEBOOK)
@Controller()
export class GradebookController {
  constructor(
    private readonly gradebook: GradebookService,
    private readonly termResults: TermResultService,
    private readonly selections: SubjectSelectionService,
  ) {}

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

  // --- term-weighted subject results (report-card grades) -------------------

  /** Subject-teacher roster: students offering a subject in a class for a term,
   *  with their current component scores. */
  @Get("term-results/roster")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  gradingRoster(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(rosterQuerySchema))
    q: { classId: string; subjectId: string; termId: string },
  ) {
    return this.termResults.getGradingRoster(p, q);
  }

  /** Enter/update a student's four component scores for a subject+term. */
  @Post("term-results")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  upsertResult(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(upsertResultSchema))
    body: {
      termId: string; classId: string; subjectId: string; studentId: string;
      exam?: number | null; midterm?: number | null; assignment?: number | null; classNote?: number | null;
    },
  ) {
    return this.termResults.upsertResult(p, body);
  }

  /** Request publication of a class-subject-term's draft results. MAKER-CHECKER:
   *  this raises a GRADE_PUBLISH workflow (head teacher → principal); the grades
   *  become visible to families only after the final approval. */
  @Post("term-results/publish")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  publishResults(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(publishSchema))
    body: { classId: string; subjectId: string; termId: string },
  ) {
    return this.termResults.publishResults(p, body);
  }

  /** Class broadsheet: the whole-class score sheet for a term (every student ×
   *  every subject). For the class SUPERVISOR / teachers / school-wide — the
   *  service 404s anyone else. Coarse gate is grade.read. */
  @Get("term-results/broadsheet")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  broadsheet(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(broadsheetQuerySchema))
    q: { classId: string; termId: string },
  ) {
    return this.termResults.getClassBroadsheet(p, q);
  }

  // --- per-term subject selection (student pick -> supervisor -> admin) -----

  /** Student: the current term, the subjects fixed on my class, my selection. */
  @Get("subject-selections/options")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_SELECT)
  selectionOptions(@CurrentPrincipal() p: Principal) {
    return this.selections.getOptions(p);
  }

  /** Student submits (or resubmits a rejected) term subject selection. */
  @Post("subject-selections")
  @RequirePermission(LMS_PERMISSIONS.SUBJECT_SELECT)
  submitSelection(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(selectionSubmitSchema))
    body: { termId: string; subjectIds: string[] },
  ) {
    return this.selections.submit(p, body);
  }

  /** Scoped list: student→own, supervisor→their queue, approvers/leadership→all. */
  @Get("subject-selections")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  listSelections(@CurrentPrincipal() p: Principal) {
    return this.selections.list(p);
  }

  /** Stage review. Stage 1 = the class's named supervisor; stage 2 =
   *  subject.selection.approve (school_admin/head_teacher, a different person).
   *  Coarse gate is class.read — the service enforces the real identity rules. */
  @Post("subject-selections/:id/review")
  @RequirePermission(LMS_PERMISSIONS.CLASS_READ)
  reviewSelection(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(selectionReviewSchema))
    body: { action: "APPROVE" | "REJECT"; note?: string },
  ) {
    return this.selections.review(p, id, body);
  }

  /** A student's whole-session report card (3 terms). Scoped: student→self,
   *  parent→children (published only), staff-of-class / school-wide (all). */
  @Get("term-results/report/:studentId/:sessionId")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  sessionReport(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Param("sessionId") sessionId: string,
  ) {
    return this.termResults.getStudentSessionReport(p, { studentId, sessionId });
  }

  /** Download ONE term's scoresheet as a PDF. Same scoping as the report read
   *  (student→self, parent→children PUBLISHED-only, staff-of-class all). */
  @Get("term-results/report/:studentId/:sessionId/:termId/pdf")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  async termScoresheetPdf(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Param("sessionId") sessionId: string,
    @Param("termId") termId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.termResults.generateTermScoresheetPdf(p, {
      studentId,
      sessionId,
      termId,
    });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  /** Download the whole SESSION (cumulative) report as a PDF — every term plus
   *  the per-subject session average. Same scoping as the term scoresheet. */
  @Get("term-results/report/:studentId/:sessionId/session-pdf")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  async sessionReportPdf(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Param("sessionId") sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.termResults.generateSessionReportPdf(p, { studentId, sessionId });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }
}
