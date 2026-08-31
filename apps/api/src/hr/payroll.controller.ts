import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS, REMITTANCE_KEYS } from "@sms/types";
import type { MyPayslipDto, PayrollRunDto, RemittanceScheduleDto } from "@sms/types";
import type { Response } from "express";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { PayrollService } from "./payroll.service";
import { safeFilename } from "../documents/safe-content-type";

const runSchema = z.object({
  periodYear: z.number().int().min(2000).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  runType: z.enum(["MONTHLY", "THIRTEENTH", "BONUS"]).optional(),
  bonusPercent: z.number().int().min(1).max(1000).optional(),
});
// EVERY key any country pack can name — the boundary check. WHICH of them this
// school may actually file is the SERVICE's question, because it depends on the
// school's country: two layers, like every other control here. The list was
// `["paye","pension","nhf"]`, Nigeria's three, offered to every country.
const remittanceSchema = z.object({ type: z.enum(REMITTANCE_KEYS) });

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
    return this.payroll.createRun(p, body.periodYear, body.periodMonth, body.runType ?? "MONTHLY", body.bonusPercent);
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
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
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
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
    return new StreamableFile(buffer);
  }

  /**
   * Which statutory schedules THIS school files, from its country pack.
   *
   * The page listed Nigeria's three as fixed links, so a British school was
   * offered a National Housing Fund download and had no National Insurance one
   * at all. Offering a control the server refuses is the defect this repo keeps
   * recording; so is hiding one it would accept.
   */
  @Get("remittance-schedules")
  @RequirePermission(HR_PERMISSIONS.HR_PAYROLL_RUN)
  async remittanceSchedules(@CurrentPrincipal() p: Principal): Promise<RemittanceScheduleDto[]> {
    return this.payroll.remittanceSchedules(p);
  }

  /** Statutory remittance schedule (CSV). WHICH schedules exist depends on the
   *  school's country pack — `remittanceSchedulesFor`, refused in the service. */
  @Get("runs/:id/remittance")
  @RequirePermission(HR_PERMISSIONS.HR_PAYROLL_RUN)
  async remittance(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(remittanceSchema)) q: z.infer<typeof remittanceSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { csv, filename } = await this.payroll.remittanceExport(p, id, q.type);
    res.set({ "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
    return new StreamableFile(Buffer.from(csv, "utf8"));
  }

  // --- staff self-service: MY payslips (hr.self; FINALIZED runs only) --------
  @Get("me/payslips")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  myPayslips(@CurrentPrincipal() p: Principal): Promise<MyPayslipDto[]> {
    return this.payroll.myPayslips(p);
  }

  @Get("me/payslips/:runId/pdf")
  @RequirePermission(HR_PERMISSIONS.HR_SELF)
  async myPayslipPdf(
    @CurrentPrincipal() p: Principal,
    @Param("runId") runId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // selfOnly: only the caller's own slip, only from a FINALIZED run.
    const { buffer, filename } = await this.payroll.payslipPdf(p, runId, p.userId, { selfOnly: true });
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
    return new StreamableFile(buffer);
  }
}
