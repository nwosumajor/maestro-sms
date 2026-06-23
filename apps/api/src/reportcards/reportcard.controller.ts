import { Controller, Param, Post, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { GRADEBOOK_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { ReportCardService } from "./reportcard.service";

@Controller("reportcards")
export class ReportCardController {
  constructor(private readonly reportcards: ReportCardService) {}

  /** Generate + download a student's report card PDF. */
  @Post(":studentId/generate")
  @RequirePermission(GRADEBOOK_PERMISSIONS.GRADE_READ)
  async generate(
    @CurrentPrincipal() p: Principal,
    @Param("studentId") studentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.reportcards.generate(p, studentId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }
}
