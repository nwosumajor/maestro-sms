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
import { studentIdsTaughtBy, teachesStudent } from "../common/teaches";
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
/** Principal, HR and the school administrator — and nobody else. */
const STAFF_DOCUMENT_READERS = new Set(["principal", "school_admin", "hr_manager", "hr_clerk"]);

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
  /** The member of staff it is about — only ever the caller themselves. */
  staffUserId?: string | null;
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
  /**
   * WHO MAY READ A MEMBER OF STAFF'S OWN DOCUMENT — the owner's decision,
   * written down where it is enforced.
   *
   * A sick note or a doctor's report is medical information about an adult, so
   * this is deliberately NOT `STAFF_WIDE_ROLES`: that set includes accountant
   * and board, who have no part in a leave decision.
   *
   * // NOTE, and it is a real gap rather than an oversight: the leave chain's
   * FIRST stage is `workflow.review.head` (head teacher / head admin), and they
   * are NOT in this set. They will approve stage one without being able to open
   * the evidence. That was the instruction; widening it is a decision about
   * medical information, not a tidy-up.
   */
  private canReadStaffDocument(p: Principal, subjectId: string): boolean {
    if (p.userId === subjectId) return true;
    return p.roles.some((r) => STAFF_DOCUMENT_READERS.has(r));
  }

  private isStaffWide(p: Principal): boolean {
    return p.roles.some((r) => STAFF_WIDE_ROLES.has(r));
  }

  // --- create + upload -------------------------------------------------------
  /** Create metadata (PENDING) and return a presigned upload URL. */
  async createDocument(p: Principal, input: CreateDocumentInput) {
    const { document } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.studentId && input.staffUserId) {
        // A document is about a pupil, about a member of staff, or about the
        // school. Two subjects would make every read scope ambiguous.
        throw new BadRequestException("A document is about a pupil or a member of staff, not both");
      }
      if (input.studentId) {
        await this.assertCanAccessStudent(tx, p, input.studentId);
      } else if (input.staffUserId) {
        // THEIR OWN, AND ONLY THEIR OWN.
        //
        // This is what makes a sick note possible at all: `createDocument` used
        // to refuse every non-student document from anyone who was not
        // school-wide, so a teacher could not produce the evidence their own
        // leave request needs. Uploading one ABOUT SOMEBODY ELSE is a different
        // act — that is what the student path and the HR record are for — so it
        // is refused here even for senior staff, who have their own routes.
        if (input.staffUserId !== p.userId) {
          throw new ForbiddenException("You can only upload a document about yourself");
        }
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
          staffUserId: input.staffUserId ?? null,
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
      const existing = await this.requireWritable(tx, p, id);

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
      return this.requireWritable(tx, p, id);
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
      await this.assertReleasable(tx, d);
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
        if (ids.length === 0) {
          // UNCHANGED for a student filter: a caller with no pupils in scope is
          // answered with nothing rather than an unfiltered query, and `fees`
          // does the same. (That it is an empty page here and a 404 below is
          // pre-existing and deliberately left alone — a test pins both, for
          // both services.)
          if (opts?.studentId) return { items: [], nextCursor: null };
          // …but their OWN documents are still theirs. Without this a teacher
          // who teaches nobody could upload a sick note and then not find it.
          where.staffUserId = p.userId;
        } else {
          // A FILTER THIS CALLER CANNOT SATISFY IS REFUSED, not widened.
          //
          // Measured live: a teacher asked for a pupil they do not teach and
          // got 200 with a report card belonging to a DIFFERENT child — the
          // same body a uuid that is nobody returned. Every row was inside
          // their scope, so nothing leaked; what was wrong is that a
          // downloadable document was presented as the answer to a filter for
          // another child.
          //
          // BEFORE any widening: an earlier version of the staff-document
          // branch answered such a filter with the caller's OWN documents,
          // which is the same defect in a new place. The existing test caught it.
          if (opts?.studentId && !ids.includes(opts.studentId)) {
            throw new NotFoundException("Document not found");
          }
          if (opts?.studentId) where.studentId = opts.studentId;
          // …OR their own: a teacher with pupils still needs to find the sick
          // note they uploaded, and one query answers both.
          else where.OR = [{ studentId: { in: ids } }, { staffUserId: p.userId }];
        }
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
      await this.assertReleasable(tx, d);
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
      // CAN YOU SEE IT — unchanged, and still 404 so a refusal never reveals
      // another pupil's document.
      if (existing.studentId) await this.assertCanAccessStudent(tx, p, existing.studentId);
      else if (!this.isStaffWide(p)) throw new NotFoundException("Document not found");
      // MAY YOU DESTROY IT — a separate question, and it used to have no answer.
      //
      // `assertCanAccessStudent` is a READ predicate: its own comments talk about
      // never revealing another pupil's document and about a teacher keeping
      // "access to their records". It admits the PUPIL, their PARENT and any
      // teacher of a class they are in — and it was the only authorisation on a
      // HARD delete of the row and of the bytes.
      //
      // The two branches above were the wrong way round: a school-level document
      // (a policy PDF) demanded school-wide staff, while a child's REPORT CARD
      // needed only family scope. The stricter guard was on the less sensitive
      // object. Measured live: a teacher read (200) and deleted (200) a report
      // card the OFFICE had generated for a pupil they teach — and the vault's
      // whole purpose is that the family has "an independently retrievable copy
      // ... no matter who generated it". The erasure path deliberately RETAINS
      // these and counts them as the school's own record; a plain delete walked
      // straight past that reasoning.
      //
      // Not a blanket refusal: `generate` files a NEW document every time, so
      // duplicates accumulate and somebody has to tidy them. You may remove what
      // you put there; removing somebody else's record needs school-wide
      // authority. That also means a family can never delete the school's copy
      // even if `document.write` were ever granted to them — Golden Rule #2,
      // rather than leaving the permission gate as the only layer.
      if (!this.isStaffWide(p) && existing.uploadedById !== p.userId) {
        // 403, not 404: they can already SEE this document, so claiming it does
        // not exist would be a positive statement that is untrue.
        throw new ForbiddenException(
          "Only school-wide staff can remove a document they did not upload. Ask the school office.",
        );
      }
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

  /**
   * The leaver gate, on EVERY door that hands over the bytes.
   *
   * It lived inline in `getDownloadUrl`, under a comment arguing that a control
   * with another way round it is not a control — and `streamFile` was the other
   * way round it. Worse, `streamFile` is the door the product uses: the web's
   * download button calls `/documents/:id/file`, so the gate was applied only
   * on the path nothing called.
   *
   * Reproduced before the fix, one exited pupil with documents unreleased, the
   * family asking for the same report card:
   *
   *     /download  403  "has left the school and their documents ... not released"
   *     /file      200  the bytes
   *
   * ACADEMIC TYPES ONLY, matching the gate's own scope. A RECEIPT is a
   * financial record the family is entitled to whatever they owe, and
   * withholding personal data over a debt is unlawful rather than firm — the
   * same distinction the gate draws for the data-protection export.
   */
  private async assertReleasable(tx: TenantTx, d: { studentId: string | null; type: string }): Promise<void> {
    if (d.studentId && GATED_ON_RELEASE.has(d.type)) {
      await assertDocumentsReleasable(tx, d.studentId);
    }
  }

  /**
   * MAY THIS CALLER PUT BYTES ON THIS DOCUMENT — the write half of
   * `requireVisible`, and deliberately NARROWER than it.
   *
   * `confirmUpload` and `uploadBytes` each hand-rolled the same two-arm check
   * and neither knew about a staff-owned document, so a teacher could create
   * their own sick note and then get 404 completing it. Three copies of one
   * rule; a fourth is how the next one drifts.
   *
   * Narrower on purpose: the principal and HR may READ a member of staff's
   * document, and replacing its bytes is a different act. Only the person it is
   * about — who is also the only person who could have created it — may do that.
   */
  private async requireWritable(tx: TenantTx, p: Principal, id: string) {
    const doc = await tx.document.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.studentId) await this.assertCanAccessStudent(tx, p, doc.studentId);
    else if (doc.staffUserId) {
      if (doc.staffUserId !== p.userId) throw new NotFoundException("Document not found");
    } else if (!this.isStaffWide(p)) throw new NotFoundException("Document not found");
    return doc;
  }

  private async requireVisible(tx: TenantTx, p: Principal, id: string) {
    const doc = await tx.document.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.studentId) {
      await this.assertCanAccessStudent(tx, p, doc.studentId);
    } else if (doc.staffUserId) {
      // 404, not 403, like every other refusal here: a caller who may not see
      // it learns nothing about whether it exists.
      if (!this.canReadStaffDocument(p, doc.staffUserId)) throw new NotFoundException("Document not found");
    } else if (!this.isStaffWide(p)) {
      throw new NotFoundException("Document not found");
    }
    return doc;
  }

  private async visibleStudentIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (p.roles.includes("student")) ids.add(p.userId);
    const children = (await tx.parentChild.findMany({
      where: { parentId: p.userId },
      select: { studentId: true },
    })) as Array<{ studentId: string }>;
    for (const c of children) ids.add(c.studentId);
    // ALL THREE teaching links — see common/teaches.ts. This asked
    // `class_teacher` alone, so a subject teacher saw none of their pupils'
    // documents while the same person could write those pupils' report-card
    // remarks. Medical stays out of reach either way: it is gated on a
    // permission no teacher holds.
    for (const id of await studentIdsTaughtBy(tx, p.userId)) ids.add(id);
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
    // ALL THREE teaching links, ACTIVE enrolment only — see common/teaches.ts.
    // The LIST path in this same file was consolidated first; leaving this one
    // asking `class_teacher` alone would have meant a subject teacher seeing a
    // pupil's document in the list and being refused when they opened it.
    if (await teachesStudent(tx, p.userId, studentId)) return;
    // SECURITY: 404 (not 403) — never reveal another student's document.
    throw new NotFoundException("Document not found");
  }

  private async notifyGuardians(p: Principal, studentId: string, title: string) {
    try {
      const { guardians, studentName } = await this.db.runAsTenant(this.ctx(p), async (tx) => ({
        guardians: (await tx.parentChild.findMany({
          where: { studentId },
          select: { parentId: true },
        })) as { parentId: string }[],
        // The catalogue entry names the pupil, and a document notice that does
        // not say WHOSE document it is makes a guardian of three open all three.
        studentName: (await tx.user.findFirst({ where: { id: studentId }, select: { name: true } }))?.name ?? "",
      }));
      for (const g of guardians) {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: g.parentId,
          type: "DOCUMENT_AVAILABLE",
          // A KEY, not a composed sentence. This is the path a REPORT CARD is
          // shared on — one of the three artifacts the message catalogue names
          // as what a francophone parent actually reads — and its translation
          // had been sitting there with no producer.
          key: "document.shared",
          params: { title, student: studentName },
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
