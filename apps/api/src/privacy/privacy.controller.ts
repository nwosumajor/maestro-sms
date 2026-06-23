import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { PRIVACY_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { PrivacyService } from "./privacy.service";

const erasureSchema = z.object({ studentId: z.string().uuid(), reason: z.string().min(1).max(1000) });
const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

@Controller("privacy")
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** Data export — relationship-scoped + audited (no special permission). */
  @Get("export/:studentId")
  export(@CurrentPrincipal() p: Principal, @Param("studentId") studentId: string) {
    return this.privacy.exportStudent(p, studentId);
  }

  /** Raise a right-to-erasure request (subject / guardian). */
  @Post("erasure")
  request(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(erasureSchema)) body: { studentId: string; reason: string },
  ) {
    return this.privacy.requestErasure(p, body);
  }

  /** List erasure requests (own, or tenant-wide for reviewers). */
  @Get("erasure")
  list(@CurrentPrincipal() p: Principal) {
    return this.privacy.listErasureRequests(p);
  }

  /** Review an erasure request (data controller). */
  @Post("erasure/:id/review")
  @RequirePermission(PRIVACY_PERMISSIONS.ERASURE_REVIEW)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: { decision: "APPROVED" | "REJECTED"; note?: string },
  ) {
    return this.privacy.reviewErasure(p, id, body.decision, body.note);
  }
}
