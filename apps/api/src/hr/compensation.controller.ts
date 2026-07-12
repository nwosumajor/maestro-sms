// =============================================================================
// CompensationController — pay components (allowances/deductions) + staff loans
// =============================================================================
// Components: hr.write manages, hr.read views (money config, audited).
// Loans: staff self-request (hr.self) → decided by a DIFFERENT person holding
// hr.salary.approve with STEP-UP (same posture as salary changes — it's money).
// =============================================================================

import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type { PayComponentDto, StaffLoanDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CompensationService } from "./compensation.service";

const componentSchema = z.object({
  kind: z.enum(["ALLOWANCE", "DEDUCTION"]),
  name: z.string().min(1).max(120),
  amountMinor: z.number().int().positive(),
});
const loanRequestSchema = z.object({
  principalMinor: z.number().int().positive(),
  monthlyMinor: z.number().int().positive(),
  purpose: z.string().min(1).max(500),
});
const loanDecideSchema = z.object({
  approve: z.boolean(),
  comment: z.string().max(500).optional(),
});

@RequireModule(MODULES.HR)
@Controller("hr")
export class CompensationController {
  constructor(private readonly comp: CompensationService) {}

  // --- pay components ---------------------------------------------------------
  @Get("employees/:userId/components")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listComponents(@CurrentPrincipal() p: Principal, @Param("userId") userId: string): Promise<PayComponentDto[]> {
    return this.comp.listComponents(p, userId);
  }

  @Post("employees/:userId/components")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  addComponent(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(componentSchema)) b: z.infer<typeof componentSchema>,
  ): Promise<PayComponentDto> {
    return this.comp.addComponent(p, userId, b);
  }

  @Delete("components/:id")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  removeComponent(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<{ deleted: boolean }> {
    return this.comp.removeComponent(p, id);
  }

  // --- loans -------------------------------------------------------------------
  /** Staff self-request (maker). */
  @Post("loans")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  requestLoan(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(loanRequestSchema)) b: z.infer<typeof loanRequestSchema>,
  ): Promise<StaffLoanDto> {
    return this.comp.requestLoan(p, b);
  }

  @Get("loans/me")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myLoans(@CurrentPrincipal() p: Principal): Promise<StaffLoanDto[]> {
    return this.comp.myLoans(p);
  }

  @Get("loans")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  listLoans(@CurrentPrincipal() p: Principal): Promise<StaffLoanDto[]> {
    return this.comp.listLoans(p);
  }

  /** Checker decides (≠ requester, enforced in the service). Step-up: money. */
  @Post("loans/:id/decide")
  @RequirePermission(HR_PERMISSIONS.HR_SALARY_APPROVE)
  @RequireStepUp()
  decideLoan(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(loanDecideSchema)) b: z.infer<typeof loanDecideSchema>,
  ): Promise<StaffLoanDto> {
    return this.comp.decideLoan(p, id, b.approve, b.comment);
  }
}
