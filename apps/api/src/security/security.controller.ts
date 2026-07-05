import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuditLogPageDto, PrivilegeGrantDto, RecertificationDto, SecurityAnomaliesDto } from "@sms/types";
import { z } from "zod";
import { SECURITY_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { SecurityService } from "./security.service";

const requestSchema = z.object({
  permission: z.string().min(1).max(80),
  reason: z.string().min(1).max(500),
  minutes: z.number().int().min(1).max(480).optional(),
  breakGlass: z.boolean().optional(),
});
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const stepUpSchema = z.object({ password: z.string().min(1) });

@Controller("security")
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  /** Scoped, filterable audit log. */
  @Get("audit")
  @RequirePermission(SECURITY_PERMISSIONS.AUDIT_READ)
  audit(
    @CurrentPrincipal() p: Principal,
    @Query("actorId") actorId?: string,
    @Query("action") action?: string,
    @Query("entity") entity?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<AuditLogPageDto> {
    return this.security.listAudit(p, {
      actorId,
      action,
      entity,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  /** Access recertification snapshot (roles->perms, users->roles, elevations). */
  @Get("recertification")
  @RequirePermission(SECURITY_PERMISSIONS.AUDIT_READ)
  recertification(@CurrentPrincipal() p: Principal): Promise<RecertificationDto> {
    return this.security.recertification(p);
  }

  /** Anomaly signals over the recent audit log. */
  @Get("anomalies")
  @RequirePermission(SECURITY_PERMISSIONS.AUDIT_READ)
  anomalies(@CurrentPrincipal() p: Principal): Promise<SecurityAnomaliesDto> {
    return this.security.anomalies(p);
  }

  /** List elevation grants (own, or tenant-wide for approvers). */
  @Get("elevation")
  @RequirePermission(SECURITY_PERMISSIONS.ELEVATION_REQUEST)
  list(@CurrentPrincipal() p: Principal): Promise<PrivilegeGrantDto[]> {
    return this.security.listElevations(p);
  }

  /** Request a temporary elevation (or break-glass). */
  @Post("elevation/request")
  @RequirePermission(SECURITY_PERMISSIONS.ELEVATION_REQUEST)
  request(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(requestSchema)) body: z.infer<typeof requestSchema>,
  ) {
    return this.security.requestElevation(p, body);
  }

  /** Approve a pending request (must differ from the requester). */
  @Post("elevation/:id/approve")
  @RequirePermission(SECURITY_PERMISSIONS.ELEVATION_APPROVE)
  approve(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.security.approveElevation(p, id);
  }

  /** Revoke a grant. */
  @Post("elevation/:id/revoke")
  @RequirePermission(SECURITY_PERMISSIONS.ELEVATION_APPROVE)
  revoke(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.security.revokeElevation(p, id);
  }

  // --- MFA (any authenticated user manages their own) ---
  @Get("mfa/status")
  mfaStatus(@CurrentPrincipal() p: Principal) {
    return this.security.mfaStatus(p);
  }

  @Post("mfa/enroll")
  mfaEnroll(@CurrentPrincipal() p: Principal) {
    return this.security.enrollMfa(p);
  }

  @Post("mfa/verify")
  mfaVerify(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ) {
    return this.security.verifyMfa(p, body.code);
  }

  /** Turning MFA off requires a fresh step-up re-auth (sensitive). */
  @Post("mfa/disable")
  @RequireStepUp()
  mfaDisable(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ) {
    return this.security.disableMfa(p, body.code);
  }

  // --- step-up re-auth ---
  @Post("stepup")
  stepUp(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(stepUpSchema)) body: { password: string },
  ) {
    return this.security.stepUp(p, body.password);
  }
}
