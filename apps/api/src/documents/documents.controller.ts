import { Body, Controller, Delete, Get, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
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
// Direct byte upload through the API (base64, like the school-logo upload). ~14MB
// base64 cap keeps a stray huge file from exhausting memory; report cards/receipts
// are far smaller.
const uploadBytesSchema = z.object({
  dataBase64: z.string().min(1).max(14_000_000),
  contentType: z.string().min(1).max(120).optional(),
});

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

  /** Upload the file bytes through the API (base64) and mark the doc UPLOADED. */
  @Post(":id/upload-bytes")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_WRITE)
  uploadBytes(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(uploadBytesSchema)) body: z.infer<typeof uploadBytesSchema>,
  ) {
    const raw = body.dataBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    return this.documents.uploadBytes(p, id, buffer, body.contentType);
  }

  /** Stream the file bytes back through the API (access-checked + audited). */
  @Get(":id/file")
  @RequirePermission(DOCUMENT_PERMISSIONS.DOCUMENT_READ)
  async file(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename, contentType } = await this.documents.streamFile(p, id);
    res.set({
      "Content-Type": contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    });
    return new StreamableFile(buffer);
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
