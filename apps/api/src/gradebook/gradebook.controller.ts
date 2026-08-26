import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS, GRADE_TOTAL_MAX } from "@sms/types";
import type { SubjectAnalyticsDto, SubjectSelectionPageDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { narrowStatus, pageNumber } from "../common/status-filter";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { LMS_PERMISSIONS } from "@sms/types";
import type { Principal } from "../integrity/integrity.foundation";
import { GradebookService } from "./gradebook.service";
import { TermResultService } from "./term-result.service";
import { SubjectSelectionService } from "./subject-selection.service";
import { safeFilename } from "../documents/safe-content-type";

const gradeSchema = z.object({
  score: z.number().nonnegative(),
  maxScore: z.number().positive(),
  feedback: z.string().max(10_000).optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
});

const uuid = z.string().uuid();
const rosterQuerySchema = z.object({ classId: uuid, subjectId: uuid, termId: uuid });
// A raw mark: a sane number at the boundary, bounded by the widest any component
// could be. The REAL ceiling is per-component AND per-school, and only the
// service knows it — it resolves the school's policy and rejects with the actual
// maximum by name.
//
// This used to cap at the PLATFORM maximum here, ahead of that check. A school
// that had raised its exam weighting to /70 then could not enter 65: the request
// was refused at the boundary, by a bound the school's own policy did not agree
// with, with a message that never mentioned which mark or which limit. The
// narrower ceiling is not the safer one when it is the wrong one.
const markField = () => z.number().min(0).max(GRADE_TOTAL_MAX).nullish();
const upsertResultSchema = z.object({
  termId: uuid,
  classId: uuid,
  subjectId: uuid,
  studentId: uuid,
  exam: markField(),
  midterm: markField(),
  assignment: markField(),
  classNote: markField(),
});
const publishSchema = z.object({ classId: uuid, subjectId: uuid, termId: uuid });
const broadsheetQuerySchema = z.object({ classId: uuid, termId: uuid });
// classId/subjectId narrow the view; omitted = every class-subject in scope.
const analyticsQuerySchema = z.object({ termId: uuid, classId: uuid.optional(), subjectId: uuid.optional() });
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

  /**
   * How each class-subject performed this term.
   *
   * Coarse gate only. `grade.read` is held by teachers, leadership, parents and
   * pupils alike, so it cannot express who may see WHICH subjects — the service
   * resolves that from the caller's own teaching offerings, and leadership from
   * READ_WIDE_ROLES. A caller with no offerings (a parent, a pupil) gets an
   * empty result rather than a refusal, because there is nothing to refuse:
   * their scope is genuinely empty.
   */
  @Get("term-results/analytics")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  subjectAnalytics(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(analyticsQuerySchema))
    q: { termId: string; classId?: string; subjectId?: string },
  ): Promise<SubjectAnalyticsDto> {
    return this.termResults.subjectAnalytics(p, q);
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
  /** `?filter=open` is the review queue (oldest first); `?filter=decided` the
   *  history. `pendingTotal` on the response is school-wide within the
   *  caller's scope and is never narrowed by the filter. */
  @Get("subject-selections")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  listSelections(
    @CurrentPrincipal() p: Principal,
    @Query("filter") filter?: string,
    @Query("page") page?: string,
  ): Promise<SubjectSelectionPageDto> {
    return this.selections.list(p, {
      filter: narrowStatus(filter, ["open", "decided"] as const, "filter"),
      page: pageNumber(page),
    });
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
      "Content-Disposition": `attachment; filename="${safeFilename(filename)}"`,
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
      "Content-Disposition": `attachment; filename="${safeFilename(filename)}"`,
    });
    return new StreamableFile(buffer);
  }
}
