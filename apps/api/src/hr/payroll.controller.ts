import { Body, Controller, Get, Param, Post, Res, StreamableFile } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { PayrollRunDto } from "@sms/types";
import type { Response } from "express";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { PayrollService } from "./payroll.service";

const runSchema = z.object({
  periodYear: z.number().int().min(2000).max(2100),
  periodMonth: z.number().int().min(1).max(12),
});

@RequireModule(MODULES.HR)
@Controller("hr/payroll")
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Post("runs")
  @RequirePermission(HR_PERMISSIONS.HR_PAYROLL_RUN)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(runSchema)) body: z.infer<typeof runSchema>,
  ): Promise<PayrollRunDto> {
    return this.payroll.createRun(p, body.periodYear, body.periodMonth);
  }

  @Get("runs")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(@CurrentPrincipal() p: Principal): Promise<PayrollRunDto[]> {
    return this.payroll.listRuns(p);
  }

  @Get("runs/:id")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PayrollRunDto> {
    return this.payroll.getRun(p, id);
  }

  @Post("runs/:id/finalize")
  @RequirePermission(HR_PERMISSIONS.HR_PAYROLL_RUN)
  finalize(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PayrollRunDto> {
    return this.payroll.finalizeRun(p, id);
  }

  /** Download the run's bank-transfer file (CSV). */
  @Get("runs/:id/bank-export")
  @RequirePermission(HR_PERMISSIONS.HR_PAYROLL_RUN)
  async bankExport(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { csv, filename } = await this.payroll.bankExport(p, id);
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  /** Download one employee's payslip for a run as a PDF. */
  @Get("runs/:id/payslips/:userId/pdf")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  async payslipPdf(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.payroll.payslipPdf(p, id, userId);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(buffer);
  }
}
