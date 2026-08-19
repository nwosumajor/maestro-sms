import { Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  MODULES,
  PRIVACY_PERMISSIONS,
  REQUIREMENT_SCOPES,
  SUBMISSION_SUBJECTS,
  type DocumentRequirementDto,
  type DocumentSubmissionDto,
  type SubmissionChecklistDto,
  type UploadTicketDto,
} from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { RequireModule } from "../auth/require-module.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { safeDownloadType, safeFilename } from "./safe-content-type";
import { SuppliedDocumentsService } from "./supplied-documents.service";
import { JobRunsService } from "../maintenance/job-runs.service";
import { SubmissionRetentionService, type SubmissionRetentionResult } from "./submission-retention.service";
import { RequirePermission } from "../auth/require-permission.decorator";

const requirementCreateSchema = z.object({
  appliesTo: z.enum(REQUIREMENT_SCOPES),
  key: z.string().min(2).max(60),
  label: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  mandatory: z.boolean().optional(),
  needsExpiry: z.boolean().optional(),
  sequence: z.number().int().min(0).max(999).optional(),
});

const requirementUpdateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  description: z.string().max(400).nullish(),
  mandatory: z.boolean().optional(),
  needsExpiry: z.boolean().optional(),
  sequence: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

const startUploadSchema = z.object({
  subjectKind: z.enum(SUBMISSION_SUBJECTS),
  subjectId: z.string().uuid(),
  requirementId: z.string().uuid().nullish(),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
});

const decideSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().max(400).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const promoteSchema = z.object({
  applicationId: z.string().uuid(),
  studentId: z.string().uuid(),
});

const waiveSchema = z.object({
  subjectKind: z.enum(SUBMISSION_SUBJECTS),
  subjectId: z.string().uuid(),
  requirementId: z.string().uuid(),
  reason: z.string().min(1).max(400),
});

/**
 * Documents a school asks a family or a candidate for.
 *
 * NO @RequirePermission, deliberately, and it is worth saying why: the authority
 * here depends on WHICH SIDE of the school the paperwork belongs to, and a
 * route decorator cannot see that — it is a property of the subject in the
 * request, not of the route.
 *
 *   a pupil's   -> student.profile.write  (principal / school_admin / junior_admin)
 *   a staff's   -> hr.write               (principal / school_admin / hr_clerk / hr_manager)
 *
 * The first attempt gated the whole controller on document.write. That reads as
 * safe and is wrong: HR roles do not hold document.write, so the people who own
 * staff onboarding were refused their own half of the module — found by calling
 * it as an hr_clerk, not by reading it. Meanwhile a teacher DOES hold
 * document.write and would have passed the gate.
 *
 * So the service decides, in one place, for every route. Anyone authenticated
 * may reach these endpoints and be refused precisely — the same posture the
 * feedback controller takes.
 */
@RequireModule(MODULES.DOCUMENTS)
@Controller("documents")
export class SuppliedDocumentsController {
  constructor(
    private readonly supplied: SuppliedDocumentsService,
    private readonly retention: SubmissionRetentionService,
    private readonly jobRuns: JobRunsService,
  ) {}

  // --- requirements ----------------------------------------------------------

  @Get("requirements")
  listRequirements(
    @CurrentPrincipal() p: Principal,
    @Query("scope") scope: string,
  ): Promise<DocumentRequirementDto[]> {
    return this.supplied.listRequirements(p, scope);
  }

  @Post("requirements")
  createRequirement(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(requirementCreateSchema)) body: z.infer<typeof requirementCreateSchema>,
  ): Promise<DocumentRequirementDto> {
    return this.supplied.createRequirement(p, body);
  }

  @Put("requirements/:id")
  updateRequirement(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(requirementUpdateSchema)) body: z.infer<typeof requirementUpdateSchema>,
  ): Promise<DocumentRequirementDto> {
    return this.supplied.updateRequirement(p, id, body);
  }

  /** Adopt the platform's starting list. Idempotent on the key — it fills an
   *  empty list, it never resets a curated one. */
  @Post("requirements/seed-defaults")
  seedDefaults(
    @CurrentPrincipal() p: Principal,
    @Query("scope") scope: string,
  ): Promise<{ created: number; existing: number }> {
    return this.supplied.seedDefaults(p, scope);
  }

  /**
   * Run the declined-applicant purge now.
   *
   * The sweep is nightly; this is for the day somebody asks "have you actually
   * deleted my child's birth certificate?" and the answer needs to be yes
   * rather than "tonight". Gated on the privacy officer's own permission,
   * because that is whose obligation it is.
   */
  @Post("retention/run")
  @RequirePermission(PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE)
  runRetention(): Promise<SubmissionRetentionResult> {
    return this.jobRuns.record("documents.submissionRetention", "MANUAL", () =>
      this.retention.purgeRejected("MANUAL"),
    );
  }

  /**
   * An accepted applicant has become a pupil — move their family's documents on
   * to them.
   *
   * EXPLICIT, because nothing in this codebase turns an accepted application
   * into an enrolled pupil: a member of staff creates the record, and this is
   * where they say which pupil it was. It is also the only link there has ever
   * been between an application and the child it was for.
   */
  @Post("promote")
  promote(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(promoteSchema)) body: z.infer<typeof promoteSchema>,
  ): Promise<{ promoted: number }> {
    return this.supplied.promoteApplication(p, body.applicationId, body.studentId);
  }

  // --- submissions -----------------------------------------------------------

  @Get("checklist")
  checklist(
    @CurrentPrincipal() p: Principal,
    @Query("subjectKind") subjectKind: string,
    @Query("subjectId") subjectId: string,
  ): Promise<SubmissionChecklistDto> {
    return this.supplied.checklist(p, subjectKind, subjectId);
  }

  @Post("submissions/upload-url")
  startUpload(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(startUploadSchema)) body: z.infer<typeof startUploadSchema>,
  ): Promise<UploadTicketDto> {
    return this.supplied.startUpload(p, body);
  }

  @Post("submissions/:id/confirm")
  confirm(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<DocumentSubmissionDto> {
    return this.supplied.confirmUpload(p, id);
  }

  @Post("submissions/:id/decide")
  decide(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(decideSchema)) body: z.infer<typeof decideSchema>,
  ): Promise<DocumentSubmissionDto> {
    return this.supplied.decide(p, id, body);
  }

  @Post("submissions/waive")
  waive(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(waiveSchema)) body: z.infer<typeof waiveSchema>,
  ): Promise<DocumentSubmissionDto> {
    return this.supplied.waive(p, body);
  }

  /**
   * The bytes.
   *
   * The SAME hardened response the Vault serves: an inert type or
   * octet-stream, always `attachment`, always nosniff. These files come from
   * members of the public, so this is the path that must never be allowed to
   * drift from the Vault's — a bespoke download route is exactly how the
   * stored-XSS this guards against got in.
   */
  @Get("submissions/:id/file")
  async file(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename, contentType } = await this.supplied.file(p, id);
    res.set({
      "Content-Type": safeDownloadType(contentType),
      "Content-Disposition": `attachment; filename="${safeFilename(filename)}"`,
      "X-Content-Type-Options": "nosniff",
    });
    return new StreamableFile(buffer);
  }
}
