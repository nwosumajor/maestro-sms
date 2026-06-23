// =============================================================================
// DocumentsService — file metadata, presigned upload/download, access control
// =============================================================================
// Postgres holds metadata + access rules; bytes live in object storage and move
// only via presigned URLs. Coarse permissions gate endpoints; this service
// narrows ROWS by relationship (same model as SIS/Attendance/Fees):
//   - staff/board (school_admin / principal / accountant / board / super_admin)
//     -> any document in tenant
//   - teacher -> documents of students they teach
//   - parent  -> their children's documents
//   - student -> their own documents
// Downloads of a student's document are audit-logged. Not-visible -> 404.
// =============================================================================

import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { DocumentTypeValue } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage.provider";

const STAFF_WIDE_ROLES = new Set([
  "school_admin",
  "principal",
  "accountant",
  "board",
  "super_admin",
]);
/** Document types whose upload notifies the student's guardians. */
const NOTIFYING_TYPES = new Set<DocumentTypeValue>(["REPORT_CARD", "CERTIFICATE", "TRANSCRIPT"]);

export interface CreateDocumentInput {
  studentId?: string | null;
  type: DocumentTypeValue;
  title: string;
  contentType: string;
  sizeBytes?: number;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger("Documents");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isStaffWide(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE_ROLES.has(r));
  }

  // --- create + upload -------------------------------------------------------
  /** Create metadata (PENDING) and return a presigned upload URL. */
  async createDocument(p: Principal, input: CreateDocumentInput) {
    const { document } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.studentId) {
        await this.assertCanAccessStudent(tx, p, input.studentId);
      } else if (!this.isStaffWide(p)) {
        // SECURITY: only school-wide staff may create non-student (school-level) docs.
        throw new ForbiddenException("Cannot create a school-level document");
      }
      const id = randomUUID();
      const storageKey = `schools/${p.schoolId}/documents/${id}/${this.slug(input.title)}`;
      const document = await tx.document.create({
        data: {
          id,
          schoolId: p.schoolId,
          studentId: input.studentId ?? null,
          type: input.type,
          title: input.title,
          storageKey,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes ?? null,
          status: "PENDING",
          uploadedById: p.userId,
        },
      });
      await this.log(tx, p, "document.create", "document", document.id, {
        studentId: input.studentId ?? null,
        type: input.type,
      });
      return { document };
    });

    const upload = await this.storage.presignUpload({
      key: document.storageKey,
      contentType: document.contentType,
    });
    return { document, upload };
  }

  /** Confirm the client finished uploading; flips PENDING -> UPLOADED and (for
   *  shareable student docs) notifies the guardians. */
  async confirmUpload(p: Principal, id: string, sizeBytes?: number) {
    const doc = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.document.findFirst({ where: { id } });
      if (!existing) throw new NotFoundException("Document not found");
      if (existing.studentId) await this.assertCanAccessStudent(tx, p, existing.studentId);
      else if (!this.isStaffWide(p)) throw new NotFoundException("Document not found");

      const updated = await tx.document.update({
        where: { id },
        data: { status: "UPLOADED", sizeBytes: sizeBytes ?? existing.sizeBytes ?? null },
      });
      await this.log(tx, p, "document.confirm", "document", id);
      return updated;
    });

    if (doc.studentId && NOTIFYING_TYPES.has(doc.type as DocumentTypeValue)) {
      await this.notifyGuardians(p, doc.studentId, doc.title);
    }
    return doc;
  }

  // --- reads -----------------------------------------------------------------
  async listDocuments(p: Principal, opts?: { studentId?: string; type?: DocumentTypeValue }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts?.type) where.type = opts.type;
      if (this.isStaffWide(p)) {
        if (opts?.studentId) where.studentId = opts.studentId;
      } else {
        const ids = await this.visibleStudentIds(tx, p);
        if (ids.length === 0) return [];
        where.studentId =
          opts?.studentId && ids.includes(opts.studentId) ? opts.studentId : { in: ids };
      }
      return tx.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
    });
  }

  async getDocument(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => this.requireVisible(tx, p, id));
  }

  /** Presigned download URL — access-checked and audit-logged. */
  async getDownloadUrl(p: Principal, id: string) {
    const doc = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const d = await this.requireVisible(tx, p, id);
      if (d.status !== "UPLOADED") throw new NotFoundException("Document not available");
      // Golden Rule #5: log access to a student's document, with the actor.
      await this.log(tx, p, "document.download", "document", id, { studentId: d.studentId });
      return d;
    });
    const download = await this.storage.presignDownload({
      key: doc.storageKey,
      filename: doc.title,
    });
    return { document: doc, download };
  }

  // --- delete ----------------------------------------------------------------
  async deleteDocument(p: Principal, id: string) {
    const key = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = await tx.document.findFirst({ where: { id } });
      if (!existing) throw new NotFoundException("Document not found");
      if (existing.studentId) await this.assertCanAccessStudent(tx, p, existing.studentId);
      else if (!this.isStaffWide(p)) throw new NotFoundException("Document not found");
      await tx.document.delete({ where: { id } });
      await this.log(tx, p, "document.delete", "document", id);
      return existing.storageKey as string;
    });
    // Best-effort object cleanup; metadata is already gone.
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.error(`Storage delete failed for ${key}: ${String(err)}`);
    }
    return { id, deleted: true };
  }

  // --- helpers ---------------------------------------------------------------
  private slug(title: string): string {
    const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "file";
  }

  private async requireVisible(tx: TenantTx, p: Principal, id: string) {
    const doc = await tx.document.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.studentId) {
      await this.assertCanAccessStudent(tx, p, doc.studentId);
    } else if (!this.isStaffWide(p)) {
      throw new NotFoundException("Document not found");
    }
    return doc;
  }

  private async visibleStudentIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) ids.add(p.userId);
    const links = await tx.parentChild.findMany({
      where: { parentId: p.userId },
      select: { studentId: true },
    });
    links.forEach((l: { studentId: string }) => ids.add(l.studentId));
    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (taught.length > 0) {
      const enrolled = await tx.enrollment.findMany({
        where: { classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { studentId: true },
      });
      enrolled.forEach((e: { studentId: string }) => ids.add(e.studentId));
    }
    return [...ids];
  }

  private async assertCanAccessStudent(tx: TenantTx, p: Principal, studentId: string) {
    if (this.isStaffWide(p)) return;
    if (p.userId === studentId) return;
    const link = await tx.parentChild.findFirst({
      where: { parentId: p.userId, studentId },
      select: { id: true },
    });
    if (link) return;
    const taught = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (taught.length > 0) {
      const enrolled = await tx.enrollment.findFirst({
        where: { studentId, classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { id: true },
      });
      if (enrolled) return;
    }
    // SECURITY: 404 (not 403) — never reveal another student's document.
    throw new NotFoundException("Document not found");
  }

  private async notifyGuardians(p: Principal, studentId: string, title: string) {
    try {
      const guardians = await this.db.runAsTenant(this.ctx(p), (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      for (const g of guardians as { parentId: string }[]) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: g.parentId,
          type: "DOCUMENT_AVAILABLE",
          title: "New document available",
          body: `A new document "${title}" is available in the school portal.`,
          channels: ["EMAIL"],
        });
      }
    } catch (err) {
      this.logger.error(`Document notification failed for student ${studentId}: ${String(err)}`);
    }
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
