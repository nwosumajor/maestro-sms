import { Body, Controller, Get, Header, Param, Post } from "@nestjs/common";
import { MODULES, SIS_PERMISSIONS } from "@sms/types";
import type { CreateParentResultDto, ParentImportBatchDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ParentImportService } from "./parent-import.service";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(40).nullish(),
  studentIds: z.array(z.string().uuid()).max(50).optional(),
  relationship: z.string().max(60).nullish(),
});

const rowSchema = z.object({
  name: z.string().min(1).max(200),
  contactEmail: z.string().email().max(200),
  phone: z.string().max(40).nullish(),
  studentAdmissionNumbers: z.string().max(500).nullish(),
  studentEmails: z.string().max(1000).nullish(),
  relationship: z.string().max(60).nullish(),
});
const stageSchema = z.object({ rows: z.array(rowSchema).min(1).max(1000) });
const rejectSchema = z.object({ note: z.string().max(1000).optional() });

// Parent onboarding. Single create + bulk upload both gate on parent.import and
// require step-up (they mint credentials). Bulk approval is maker-checker in the
// service (a DIFFERENT person must approve).
@RequireModule(MODULES.SIS)
@Controller("admin/parents")
export class ParentImportController {
  constructor(private readonly parents: ParentImportService) {}

  /** Onboard ONE parent (or reuse an existing email) + link to students. */
  @Post()
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  createSingle(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema))
    body: { name: string; email: string; phone?: string | null; studentIds?: string[]; relationship?: string | null },
  ): Promise<CreateParentResultDto> {
    return this.parents.createSingle(p, body);
  }

  /** Blank CSV template (header + one example row). */
  @Get("import/template")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="parent-import-template.csv"')
  template(): string {
    return this.parents.csvTemplate();
  }

  /** Stage a PENDING batch (creates nothing yet). */
  @Post("import")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  stage(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(stageSchema)) body: { rows: z.infer<typeof rowSchema>[] },
  ): Promise<ParentImportBatchDto> {
    return this.parents.stage(p, body.rows);
  }

  @Get("import")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  list(@CurrentPrincipal() p: Principal): Promise<ParentImportBatchDto[]> {
    return this.parents.list(p);
  }

  @Get("import/:id")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  getBatch(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ParentImportBatchDto> {
    return this.parents.get(p, id);
  }

  /** Approve (SoD: different person) — creates accounts + links; credentials once. */
  @Post("import/:id/approve")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  approve(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<ParentImportBatchDto> {
    return this.parents.approve(p, id);
  }

  @Post("import/:id/reject")
  @RequirePermission(SIS_PERMISSIONS.PARENT_IMPORT)
  reject(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: { note?: string },
  ): Promise<ParentImportBatchDto> {
    return this.parents.reject(p, id, body.note);
  }
}
