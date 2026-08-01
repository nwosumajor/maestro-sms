// Compliance surface: the breach register (GDPR Art. 33/34) and the posture
// screen a school shows its data-protection officer. ALWAYS-ON (no @RequireModule)
// — a legal obligation is not an add-on somebody can fail to buy.

import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { BREACH_RISK_LEVELS, BREACH_STATUSES, PRIVACY_PERMISSIONS } from "@sms/types";
import type { BreachIncidentDto, CompliancePostureDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ComplianceService } from "./compliance.service";

const reportSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(4000),
  /** When the school BECAME AWARE — this is what starts the 72-hour clock. */
  discoveredAt: z.string().datetime(),
  riskLevel: z.enum(BREACH_RISK_LEVELS).optional(),
  affectedCount: z.number().int().min(0).max(10_000_000).optional(),
  dataCategories: z.string().max(500).optional(),
});

const updateSchema = z.object({
  status: z.enum(BREACH_STATUSES).optional(),
  riskLevel: z.enum(BREACH_RISK_LEVELS).optional(),
  // Nullable: clearing a notification date is a legitimate correction.
  notifiedAuthorityAt: z.string().datetime().nullish(),
  notifiedSubjectsAt: z.string().datetime().nullish(),
  noNotificationReason: z.string().max(1000).nullish(),
  affectedCount: z.number().int().min(0).max(10_000_000).optional(),
});

@Controller("privacy/compliance")
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  /** One screen for a DPO: regime, DPO contact, breach clock, retention, consent
   *  coverage — and what is MISSING as loudly as what is present. */
  @Get("posture")
  @RequirePermission(PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE)
  posture(@CurrentPrincipal() p: Principal): Promise<CompliancePostureDto> {
    return this.compliance.posture(p);
  }

  /** The breach register, overdue first. */
  @Get("breaches")
  @RequirePermission(PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE)
  breaches(@CurrentPrincipal() p: Principal): Promise<BreachIncidentDto[]> {
    return this.compliance.listBreaches(p);
  }

  /** Record a breach. Deliberately NOT step-up gated: a 72-hour clock is running
   *  and putting a re-auth between somebody and reporting it is the wrong trade. */
  @Post("breaches")
  @RequirePermission(PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE)
  report(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(reportSchema)) body: z.infer<typeof reportSchema>,
  ): Promise<BreachIncidentDto> {
    return this.compliance.reportBreach(p, body);
  }

  /** Record what was done about it. `discoveredAt` is deliberately not updatable —
   *  it is when the clock started. */
  @Put("breaches/:id")
  @RequirePermission(PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<BreachIncidentDto> {
    return this.compliance.updateBreach(p, id, body);
  }
}
