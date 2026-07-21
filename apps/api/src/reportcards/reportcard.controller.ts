import { Body, Controller, Get, Param, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { Response } from "express";
import { z } from "zod";
import { GRADEBOOK_PERMISSIONS } from "@sms/types";
import type { ReportCardRemarkDto } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ReportCardService } from "./reportcard.service";
import { ReportCardRemarkService } from "./report-card-remark.service";

const remarkSchema = z.object({ termId: z.string().uuid(), remark: z.string().min(1).max(2000) });

@RequireModule(MODULES.DOCUMENTS)
@Controller("reportcards")
export class ReportCardController {
  constructor(
    private readonly reportcards: ReportCardService,
    private readonly remarks: ReportCardRemarkService,
  ) {}

  /** Generate + download a student's report card PDF (optionally for a term,
   *  which pulls in that term's class-teacher and head remarks). */
  @Post(":studentId/generate")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  async generate(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Res({ passthrough: true }) res: Response,
    @Query("termId") termId?: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.reportcards.generate(p, studentId, termId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  /** Read a student's remarks for a term (report-card scope). */
  @Get(":studentId/remarks")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  getRemarks(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Query("termId") termId: string,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.get(p, studentId, termId);
  }

  /** Class teacher (or staff-wide) writes the class-teacher remark. */
  @Put(":studentId/remarks/class-teacher")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_WRITE)
  setClassTeacherRemark(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(remarkSchema)) body: z.infer<typeof remarkSchema>,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.setClassTeacherRemark(p, studentId, body.termId, body.remark);
  }

  /** Principal / school admin writes the head remark. */
  @Put(":studentId/remarks/head")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  setHeadRemark(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Body(new ZodValidationPipe(remarkSchema)) body: z.infer<typeof remarkSchema>,
  ): Promise<ReportCardRemarkDto> {
    return this.remarks.setHeadRemark(p, studentId, body.termId, body.remark);
  }
}
