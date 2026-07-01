import { RequireModule } from "../auth/require-module.decorator";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { DISCIPLINE_PERMISSIONS, MODULES } from "@sms/types";
import type { DisciplineComplaintDto, DisciplineEvidencePresignDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DisciplineService } from "./discipline.service";

const fileSchema = z.object({
  subject: z.string().min(1).max(200),
  details: z.string().max(5000).optional(),
  againstId: z.string().uuid(),
  againstType: z.enum(["STUDENT", "TEACHER"]).default("STUDENT"),
});
const assignSchema = z.object({ assigneeId: z.string().uuid() });
const entrySchema = z.object({ body: z.string().min(1).max(2000) });
const resolveSchema = z.object({ status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"]), resolution: z.string().max(2000).optional() });
const presignSchema = z.object({ fileName: z.string().min(1).max(200), contentType: z.string().min(1).max(120) });
const confirmSchema = z.object({ key: z.string().min(1).max(400), fileName: z.string().min(1).max(200) });

@RequireModule(MODULES.DISCIPLINE)
@Controller("discipline")
export class DisciplineController {
  constructor(private readonly discipline: DisciplineService) {}

  @Get("complaints")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_FILE)
  list(@CurrentPrincipal() p: Principal): Promise<DisciplineComplaintDto[]> {
    return this.discipline.list(p);
  }

  @Get("complaints/:id")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_FILE)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<DisciplineComplaintDto> {
    return this.discipline.get(p, id);
  }

  @Post("complaints")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_FILE)
  file(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(fileSchema)) b: z.infer<typeof fileSchema>): Promise<DisciplineComplaintDto> {
    return this.discipline.file(p, b);
  }

  // staff review (discipline.manage enforced in the service)
  @Post("complaints/:id/assign")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  assign(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(assignSchema)) b: z.infer<typeof assignSchema>): Promise<DisciplineComplaintDto> {
    return this.discipline.assign(p, id, b.assigneeId);
  }

  @Post("complaints/:id/entries")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  entry(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(entrySchema)) b: z.infer<typeof entrySchema>): Promise<DisciplineComplaintDto> {
    return this.discipline.addEntry(p, id, b.body);
  }

  @Post("complaints/:id/resolve")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  resolve(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(resolveSchema)) b: z.infer<typeof resolveSchema>): Promise<DisciplineComplaintDto> {
    return this.discipline.resolve(p, id, b);
  }

  @Post("complaints/:id/evidence/presign")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  presign(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(presignSchema)) b: z.infer<typeof presignSchema>): Promise<DisciplineEvidencePresignDto> {
    return this.discipline.presignEvidence(p, id, b);
  }

  @Post("complaints/:id/evidence/confirm")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  confirm(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body(new ZodValidationPipe(confirmSchema)) b: z.infer<typeof confirmSchema>): Promise<DisciplineComplaintDto> {
    return this.discipline.confirmEvidence(p, id, b);
  }

  @Get("complaints/:id/evidence/:evidenceId")
  @RequirePermission(DISCIPLINE_PERMISSIONS.DISCIPLINE_MANAGE)
  download(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Param("evidenceId") evidenceId: string): Promise<{ url: string }> {
    return this.discipline.downloadEvidence(p, id, evidenceId);
  }
}
