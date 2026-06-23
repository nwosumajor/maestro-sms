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

import { Body, Controller, Param, Post, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { clientSignalBatchSchema } from "@sms/types";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
// --- foundation primitives (do not reimplement) ---
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContext } from "./integrity.foundation";
import { IntegrityService } from "./integrity.service";

const contentSchema = z.object({ content: z.string().max(200_000) });

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
}
