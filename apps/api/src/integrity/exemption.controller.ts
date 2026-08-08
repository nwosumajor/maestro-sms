// =============================================================================
// ExemptionController — the write path for accessibility accommodations
// =============================================================================
// `integrity.exemption.write` and `integrity.exemption.read` existed, were
// seeded to teacher/school_admin/principal, and gated NOTHING: measured against
// all 148 defined permissions they were the only two with no enforcement
// anywhere. The table, the RLS policy and the read that switches monitoring off
// were all already there — only the endpoints were missing, so the
// accommodation /help promises to students could never actually be granted.
//
// Its own controller rather than a method on IntegrityController: that one is
// mounted under
// `assessments/:assessmentId/submissions/:submissionId`, and an accommodation is
// most often GLOBAL — it belongs to the pupil, not to one submission.
// =============================================================================

import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
import type { IntegrityExemptionDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "./integrity.foundation";
import { ExemptionService } from "./exemption.service";

const grantSchema = z.object({
  studentId: z.string().uuid(),
  /** Omitted or null = every assessment. */
  assessmentId: z.string().uuid().nullish(),
  // A reason is REQUIRED. An accommodation with no stated basis cannot be
  // reviewed later, and this record is about a child's disability.
  reason: z.string().min(3).max(500),
});
const revokeSchema = z.object({ reason: z.string().max(500).optional() });

@Controller("integrity/exemptions")
export class ExemptionController {
  constructor(private readonly exemptions: ExemptionService) {}

  /** Accommodations the caller may see — own pupils for a teacher, school-wide
   *  for school_admin/principal. Audited: this is a sensitive read. */
  @Get()
  @RequirePermission(INTEGRITY_PERMISSIONS.EXEMPTION_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("studentId") studentId?: string,
  ): Promise<IntegrityExemptionDto[]> {
    return this.exemptions.list(p, studentId);
  }

  @Post()
  @RequirePermission(INTEGRITY_PERMISSIONS.EXEMPTION_WRITE)
  grant(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(grantSchema)) body: z.infer<typeof grantSchema>,
  ): Promise<IntegrityExemptionDto> {
    return this.exemptions.grant(p, body);
  }

  /** Withdraw it. DELETE by verb only — the row is soft-revoked and kept, and
   *  the RLS policy grants the app role no DELETE on this table at all. */
  @Delete(":id")
  @RequirePermission(INTEGRITY_PERMISSIONS.EXEMPTION_WRITE)
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
  ): Promise<IntegrityExemptionDto> {
    return this.exemptions.revoke(p, id, body.reason);
  }
}
