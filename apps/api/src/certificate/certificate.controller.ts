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
import { safeFilename } from "../documents/safe-content-type";

const issueSchema = z.object({
  type: z.enum(["ID_CARD", "COMPLETION", "PARTICIPATION", "MERIT"]),
  subjectId: z.string().uuid(),
  title: z.string().max(160).optional(),
  body: z.string().max(600).optional(),
});
const issueClassSchema = z.object({
  classId: z.string().uuid(),
  type: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
  body: z.string().max(2000).optional(),
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
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeFilename(filename)}"` });
    return new StreamableFile(buffer);
  }

  /**
   * Register a certificate for every enrolled pupil in a class who does not already
   * hold one of that type. Returns the class with an already-issued flag; the PDFs
   * are still produced per pupil by POST /certificates/issue, which the console
   * links to. Idempotent — pressing it twice never mints a second certificate.
   */
  @Post("issue-class")
  @RequirePermission(CERTIFICATE_PERMISSIONS.CERTIFICATE_ISSUE)
  issueClass(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(issueClassSchema)) body: z.infer<typeof issueClassSchema>,
  ) {
    return this.certificates.issueForClass(p, body);
  }

  @Get("history/:subjectId")
  @RequirePermission(CERTIFICATE_PERMISSIONS.CERTIFICATE_ISSUE)
  history(@CurrentPrincipal() p: Principal, @Param("subjectId") subjectId: string) {
    return this.certificates.history(p, subjectId);
  }
}
