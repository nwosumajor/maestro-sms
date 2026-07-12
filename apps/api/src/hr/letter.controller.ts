// =============================================================================
// LetterController — official HR letters (hr.write issues; audited w/ ref no).
// =============================================================================

import { Controller, Get, Param, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { LetterService } from "./letter.service";

const typeSchema = z.object({ type: z.enum(["EMPLOYMENT", "CONFIRMATION", "PROMOTION", "EXPERIENCE"]) });

@RequireModule(MODULES.HR)
@Controller("hr/letters")
export class LetterController {
  constructor(private readonly letters: LetterService) {}

  @Get(":userId/pdf")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  async letter(
    @CurrentPrincipal() p: Principal,
    @Param("userId") userId: string,
    @Query(new ZodValidationPipe(typeSchema)) q: z.infer<typeof typeSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.letters.generate(p, userId, q.type);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` });
    return new StreamableFile(buffer);
  }
}
