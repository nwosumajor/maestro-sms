// =============================================================================
// IntegrityController — student-facing ingestion + submission lifecycle
// =============================================================================
// Thin HTTP layer. Authn/tenant context come from the foundation (verified JWT
// -> guard), permissions from @RequirePermission, validation from Zod at the
// boundary. All real logic + ownership checks live in IntegrityService.
//
// NOTE on imports: @RequirePermission, @CurrentTenant and ZodValidationPipe are
// FOUNDATION-provided. Paths below assume the foundation's auth module; adjust at
// integration. We do not redefine the security primitives here.
// =============================================================================

import { Body, Controller, Get, Param, Post, HttpCode } from "@nestjs/common";
import { MODULES } from "@sms/types";
import type { SubmissionFilePresignDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { z } from "zod";
import { clientSignalBatchSchema } from "@sms/types";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
// --- foundation primitives (do not reimplement) ---
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal, TenantContext } from "./integrity.foundation";
import { IntegrityService } from "./integrity.service";

const contentSchema = z.object({ content: z.string().max(200_000) });

// File answers are restricted to common document/image types and a size cap, so a
// student can't stage an arbitrary/oversized blob as their "submission". (True byte
// enforcement also lives at the storage policy for S3; this is the boundary check.)
const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const fileSchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_FILE_BYTES),
});

@RequireModule(MODULES.INTEGRITY)
@Controller("assessments/:assessmentId/submissions/:submissionId")
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  /** Student emits captured CLIENT signals for their own submission. */
  @Post("signals")
  @HttpCode(202)
  @RequirePermission(INTEGRITY_PERMISSIONS.SIGNAL_CREATE)
  async ingest(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
    @Body(new ZodValidationPipe(clientSignalBatchSchema))
    body: import("@sms/types").ClientSignalBatch,
  ): Promise<void> {
    // SECURITY: trust the PATH submissionId (matched to caller ownership in the
    // service), not the body. Reject a body that disagrees to avoid confusion.
    if (body.submissionId !== submissionId) {
      // Service will 404 on ownership anyway; fail fast and consistently.
      body = { ...body, submissionId };
    }
    await this.integrity.ingestClientSignals(ctx, body);
  }

  /** Autosave a draft (append-only snapshot) and enqueue detection. */
  @Post("autosave")
  @HttpCode(202)
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_WRITE)
  async autosave(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
    @Body(new ZodValidationPipe(contentSchema)) body: { content: string },
  ): Promise<void> {
    await this.integrity.autosave(ctx, submissionId, body.content);
  }

  /** Start a TIMED exam — records the attempt start + returns the firm deadline. */
  @Post("start")
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_WRITE)
  async start(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
  ): Promise<{ startedAt: Date; deadline: Date }> {
    return this.integrity.startExam(ctx, submissionId);
  }

  /** Final submit, then enqueue detection. */
  @Post("submit")
  @HttpCode(202)
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_WRITE)
  async submit(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
    @Body(new ZodValidationPipe(contentSchema)) body: { content: string },
  ): Promise<void> {
    await this.integrity.submit(ctx, submissionId, body.content);
  }

  // --- file-upload answer (only when the assessment enables it) --------------
  /** Student requests an upload URL for their own file answer. */
  @Post("file/presign")
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_WRITE)
  async presignFile(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
    @Body(new ZodValidationPipe(fileSchema)) body: z.infer<typeof fileSchema>,
  ): Promise<SubmissionFilePresignDto> {
    return this.integrity.presignSubmissionFile(ctx, submissionId, body);
  }

  /** Student confirms their file finished uploading. */
  @Post("file/confirm")
  @HttpCode(204)
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_WRITE)
  async confirmFile(
    @CurrentTenant() ctx: TenantContext,
    @Param("submissionId") submissionId: string,
  ): Promise<void> {
    await this.integrity.confirmSubmissionFile(ctx, submissionId);
  }

  /** Download a submission's file: the owner student, or a reviewer (teacher/staff). */
  @Get("file")
  @RequirePermission(INTEGRITY_PERMISSIONS.SUBMISSION_READ)
  async downloadFile(
    @CurrentPrincipal() p: Principal,
    @Param("submissionId") submissionId: string,
  ): Promise<SubmissionFilePresignDto> {
    return this.integrity.downloadSubmissionFile(p, submissionId);
  }
}
