import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { DocumentRowDto } from "@sms/types";
import { z } from "zod";
import { DOCUMENT_PERMISSIONS, DOCUMENT_TYPES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DocumentsService } from "./documents.service";

const createSchema = z.object({
  studentId: z.string().uuid().nullish(),
  type: z.enum(DOCUMENT_TYPES),
  title: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0).optional(),
});
const confirmSchema = z.object({ sizeBytes: z.number().int().min(0).optional() });

@RequireModule(MODULES.DOCUMENTS)
@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Create metadata + get a presigned upload URL. */
  @Post()
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_WRITE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    return this.documents.createDocument(p, body);
  }

  /** Confirm the direct upload completed. */
  @Post(":id/confirm")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_WRITE)
  confirm(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(confirmSchema)) body: z.infer<typeof confirmSchema>,
  ) {
    return this.documents.confirmUpload(p, id, body.sizeBytes);
  }

  @Get()
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("studentId") studentId?: string,
    @Query("type") type?: string,
  ): Promise<DocumentRowDto[]> {
    const t = type && DOCUMENT_TYPES.includes(type as never) ? (type as never) : undefined;
    return this.documents.listDocuments(p, { studentId, type: t });
  }

  @Get(":id")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.documents.getDocument(p, id);
  }

  /** Presigned download URL (access-checked + audited). */
  @Get(":id/download")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_READ)
  download(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.documents.getDownloadUrl(p, id);
  }

  @Delete(":id")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_WRITE)
  remove(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.documents.deleteDocument(p, id);
  }
}
