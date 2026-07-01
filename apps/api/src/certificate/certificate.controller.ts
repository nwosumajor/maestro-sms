import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { CERTIFICATE_PERMISSIONS, MODULES } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { CertificateService } from "./certificate.service";

const issueSchema = z.object({
  type: z.enum(["ID_CARD", "COMPLETION", "PARTICIPATION", "MERIT"]),
  subjectId: z.string().uuid(),
  title: z.string().max(160).optional(),
  body: z.string().max(600).optional(),
});

@RequireModule(MODULES.CERTIFICATE)
@Controller("certificates")
export class CertificateController {
  constructor(private readonly certificates: CertificateService) {}

  /** Issue a certificate / ID card — streams the generated PDF. */
  @Post("issue")
  @RequirePermission(CERTIFICATE_PERMISSIONS.CERTIFICATE_ISSUE)
  async issue(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(issueSchema)) body: z.infer<typeof issueSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.certificates.issue(p, body);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(buffer);
  }

  @Get("history/:subjectId")
  @RequirePermission(CERTIFICATE_PERMISSIONS.CERTIFICATE_ISSUE)
  history(@CurrentPrincipal() p: Principal, @Param("subjectId") subjectId: string) {
    return this.certificates.history(p, subjectId);
  }
}
