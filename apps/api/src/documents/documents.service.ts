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

import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
import { assertDocumentsReleasable } from "../lms/leaver-documents";

// junior_admin is the operational tier that owns the document vault (CLAUDE.md)
// and holds document.write; without it here, both student-doc and school-level
// uploads were blocked (a dead grant). It gains vault access across the school —
// like accountant/board already have. Mirrors the SIS fix.
const STAFF_WIDE_ROLES = new Set([
  "school_admin",
  "principal",
  "accountant",
  "board",
  "junior_admin",
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

/** Documents per page. A term's report-card run for a class is ~30-40 files. */
const DOCUMENT_PAGE_SIZE = 50;
/** Ceiling a caller can request per page. */
const DOCUMENT_PAGE_MAX = 200;

/**
 * Document types the leaver gate covers: the academic artefacts a school
 * withholds pending settlement. Deliberately NOT receipts (a financial record
 * the family is owed) or OTHER (which is where a data-protection export would
 * land, and that is never a debt-collection lever).
 */
const GATED_ON_RELEASE = new Set(["REPORT_CARD", "CERTIFICATE", "TRANSCRIPT"]);

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

      // THE BYTES MUST ACTUALLY BE THERE.
      //
      // This confirms a presigned PUT, which happens between the browser and the
      // bucket where the API cannot see it. It took the client's word for it —
      // flipped the document to UPLOADED and, for a report card or certificate,
      // notified the guardians. So an upload that silently failed produced a
      // family told their child's document was ready and a download that 404s,
      // with the record asserting otherwise.
      //
      // The other upload path writes the bytes itself and so has always been
      // safe; this one is the door that could not tell.
      if (!(await this.storage.exists(existing.storageKey))) {
        throw new BadRequestException(
          "The file has not arrived in storage — the upload did not complete. Try uploading it again.",
        );
      }

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

  /** Store the actual file bytes through the API (works with the local stub AND
   *  S3/R2 via the same StorageProvider) and flip the doc to UPLOADED. This is
   *  the API-mediated alternative to a direct presigned PUT — right for the small
   *  PDFs/receipts the Vault holds, and the only path that works in local dev. */
  async uploadBytes(p: Principal, id: string, body: Buffer, contentType?: string) {
    if (body.length === 0) throw new BadRequestException("empty file");
    const existing = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const doc = await tx.document.findFirst({ where: { id } });
      if (!doc) throw new NotFoundException("Document not found");
      if (doc.studentId) await this.assertCanAccessStudent(tx, p, doc.studentId);
      else if (!this.isStaffWide(p)) throw new NotFoundException("Document not found");
      return doc;
    });
    await this.storage.upload({
      key: existing.storageKey,
      body,
      contentType: contentType || existing.contentType,
    });
    const updated = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.document.update({
        where: { id },
        data: { status: "UPLOADED", sizeBytes: body.length },
      });
      await this.log(tx, p, "document.upload", "document", id, { bytes: body.length });
      return u;
    });
    if (updated.studentId && NOTIFYING_TYPES.has(updated.type as DocumentTypeValue)) {
      await this.notifyGuardians(p, updated.studentId, updated.title);
    }
    return updated;
  }

  /** Stream a document's bytes through the API (access-checked + audited). Works
   *  with the stub (filesystem) and S3/R2 (GetObject) — the browser needs no
   *  bucket credentials. */
  async streamFile(p: Principal, id: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const doc = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const d = await this.requireVisible(tx, p, id);
      if (d.status !== "UPLOADED") throw new NotFoundException("Document not available");
      await this.log(tx, p, "document.download", "document", id, { studentId: d.studentId });
      return d;
    });
    const bytes = await this.storage.download(doc.storageKey);
    if (!bytes) throw new NotFoundException("File not found in storage");
    return { buffer: bytes, filename: doc.title, contentType: doc.contentType };
  }

  // --- reads -----------------------------------------------------------------
  /**
   * Documents, filtered and PAGED.
   *
   * The type/student filters existed already and the page passed neither, so a
   * school saw the 200 most recent documents in one list with everything older
   * unreachable — the same ceiling the invoice list had. A vault that accumulates
   * report cards and receipts every term passes 200 within a year.
   *
   * Cursor paging, not offset: an offset shifts when a document is uploaded
   * mid-browse, silently skipping or repeating rows.
   */
  async listDocuments(
    p: Principal,
    opts?: { studentId?: string; type?: DocumentTypeValue; cursor?: string; limit?: number },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts?.limit ?? DOCUMENT_PAGE_SIZE, 1), DOCUMENT_PAGE_MAX);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (opts?.type) where.type = opts.type;
      if (this.isStaffWide(p)) {
        if (opts?.studentId) where.studentId = opts.studentId;
      } else {
        const ids = await this.visibleStudentIds(tx, p);
        if (ids.length === 0) return { items: [], nextCursor: null };
        where.studentId =
          opts?.studentId && ids.includes(opts.studentId) ? opts.studentId : { in: ids };
      }
      // One extra row tells us whether another page exists, without a second query.
      const rows = (await tx.document.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      })) as Array<{ id: string }>;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
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
      // The leaver gate applies HERE too, or it does not apply at all.
      //
      // Generating a report card or issuing a certificate for a withheld leaver
      // is refused. But generating a report card also FILES a copy in this vault
      // — so every artefact the gate blocks at issue was already retrievable
      // through a second door, and a family could simply download the previous
      // term's copy. A control with another way round it is not a control.
      //
      // ACADEMIC TYPES ONLY, matching the gate's own scope. A RECEIPT is a
      // financial record the family is entitled to whatever they owe, and
      // withholding personal data over a debt is unlawful rather than firm —
      // the same distinction the gate draws for the data-protection export.
      if (d.studentId && GATED_ON_RELEASE.has(d.type as string)) {
        await assertDocumentsReleasable(tx, d.studentId);
      }
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
      // SECURITY: ACTIVE only. Without the status filter this asked "was this
      // pupil EVER in a class I teach", so a teacher kept access to a pupil who
      // had since withdrawn, transferred or been promoted out — indefinitely,
      // and to their records rather than merely their name. Proven live: a
      // pupil was set to WITHDRAWN and their old teacher still fetched a signed
      // download URL for their report card. Whole-school staff are unaffected,
      // so the school can still produce a departed pupil's paperwork.
      const enrolled = await tx.enrollment.findMany({
        where: { status: "ACTIVE", classId: { in: taught.map((t: { classId: string }) => t.classId) } },
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
      // SECURITY: ACTIVE only. Without the status filter this asked "was this
      // pupil EVER in a class I teach", so a teacher kept access to a pupil who
      // had since withdrawn, transferred or been promoted out — indefinitely,
      // and to their records rather than merely their name. Proven live: a
      // pupil was set to WITHDRAWN and their old teacher still fetched a signed
      // download URL for their report card. Whole-school staff are unaffected,
      // so the school can still produce a departed pupil's paperwork.
      const enrolled = await tx.enrollment.findFirst({
        where: { studentId, status: "ACTIVE", classId: { in: taught.map((t: { classId: string }) => t.classId) } },
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
