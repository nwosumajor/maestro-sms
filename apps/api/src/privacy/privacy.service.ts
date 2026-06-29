// =============================================================================
// PrivacyService — NDPR data-subject rights: export + erasure requests
// =============================================================================
// Export gathers a student's personal data across modules (RLS-scoped) into one
// bundle and audit-logs the disclosure. Medical fields are decrypted only if the
// caller may read them. Erasure is a governed request: raised by a subject/
// guardian, reviewed by a controller against retention obligations — never a
// one-click deletion of a minor's record.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { decryptField } from "../foundation/field-crypto";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);
const MEDICAL_FIELDS = ["bloodGroup", "allergies", "conditions", "medications", "dietaryNotes", "notes"];

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- export ----------------------------------------------------------------
  async exportStudent(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccess(tx, p, studentId);
      const student = await tx.user.findFirst({
        where: { id: studentId },
        select: { id: true, name: true, email: true, createdAt: true },
      });
      if (!student) throw new NotFoundException("Student not found");

      const profile = await tx.studentProfile.findFirst({ where: { studentId } });
      const contacts = profile
        ? await tx.emergencyContact.findMany({ where: { profileId: profile.id } })
        : [];
      let medical: Record<string, unknown> | null = null;
      if (profile && p.permissions.includes("student.medical.read")) {
        const m = await tx.medicalRecord.findFirst({ where: { profileId: profile.id } });
        if (m) {
          const dec: Record<string, unknown> = { ...m };
          for (const f of MEDICAL_FIELDS) {
            if (typeof dec[f] === "string") dec[f] = decryptField(dec[f] as string, p.schoolId);
          }
          medical = dec;
        }
      }
      const [enrollments, attendance, invoices, documents, notifications] = await Promise.all([
        tx.enrollment.findMany({ where: { studentId } }),
        tx.attendanceRecord.findMany({ where: { studentId }, orderBy: { createdAt: "desc" } }),
        tx.invoice.findMany({ where: { studentId }, include: { lineItems: true, payments: true } }),
        tx.document.findMany({
          where: { studentId },
          select: { id: true, type: true, title: true, status: true, createdAt: true },
        }),
        tx.notification.findMany({ where: { recipientId: studentId }, orderBy: { createdAt: "desc" }, take: 100 }),
      ]);

      await this.log(tx, p, "privacy.export", studentId);
      return {
        exportedAt: new Date().toISOString(),
        exportedBy: p.userId,
        student,
        profile,
        emergencyContacts: contacts,
        medical: medical ?? "(not included — insufficient permission)",
        enrollments,
        attendance,
        invoices,
        documents,
        notifications,
      };
    });
  }

  // --- erasure requests ------------------------------------------------------
  async requestErasure(p: Principal, input: { studentId: string; reason: string }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccess(tx, p, input.studentId);
      const req = await tx.erasureRequest.create({
        data: {
          schoolId: p.schoolId,
          studentId: input.studentId,
          requestedById: p.userId,
          reason: input.reason,
        },
      });
      await this.log(tx, p, "privacy.erasure.request", req.id, { studentId: input.studentId });
      return req;
    });
  }

  async listErasureRequests(p: Principal) {
    const canReview = p.permissions.includes("privacy.erasure.review");
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.erasureRequest.findMany({
        where: canReview ? {} : { requestedById: p.userId },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
  }

  async reviewErasure(p: Principal, id: string, decision: "APPROVED" | "REJECTED", note?: string) {
    const { updated, fileKeys } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = await tx.erasureRequest.findFirst({ where: { id } });
      if (!req) throw new NotFoundException("Request not found");
      if (req.status !== "PENDING") throw new ForbiddenException("Request is already reviewed");
      const updated = await tx.erasureRequest.update({
        where: { id },
        data: { status: decision, reviewedById: p.userId, reviewNote: note ?? null },
      });

      // NDPR right-to-erasure: on APPROVAL, remove the subject's uploaded
      // submission FILES — minors' PII that lives in object storage and is not
      // covered by the integrity-telemetry retention sweep. We null the keys in-tx
      // and delete the bytes after commit (best-effort). The academic submission
      // ROW + grade are retained as the school's record; only the student-supplied
      // file blob is erased, consistent with the governed-deletion model.
      let fileKeys: string[] = [];
      if (decision === "APPROVED") {
        const withFiles = await tx.submission.findMany({
          where: { studentId: req.studentId, fileKey: { not: null } },
          select: { id: true, fileKey: true },
        });
        fileKeys = withFiles.map((s) => s.fileKey).filter((k): k is string => Boolean(k));
        if (withFiles.length > 0) {
          await tx.submission.updateMany({
            where: { studentId: req.studentId, fileKey: { not: null } },
            data: { fileKey: null, fileName: null, fileUploaded: false },
          });
        }
      }

      await this.log(tx, p, `privacy.erasure.${decision.toLowerCase()}`, id, {
        studentId: req.studentId,
        ...(decision === "APPROVED" ? { erasedSubmissionFiles: fileKeys.length } : {}),
      });
      return { updated, fileKeys };
    });

    // Delete the bytes from storage after the tx commits (best-effort).
    for (const key of fileKeys) {
      await this.storage.delete(key).catch(() => undefined);
    }
    return updated;
  }

  // --- helpers ---------------------------------------------------------------
  private async assertCanAccess(tx: TenantTx, p: Principal, studentId: string) {
    if (p.roles.some((r) => STAFF_WIDE.has(r))) return;
    if (p.userId === studentId) return;
    const link = await tx.parentChild.findFirst({
      where: { parentId: p.userId, studentId },
      select: { id: true },
    });
    if (link) return;
    throw new NotFoundException("Student not found");
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata?: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "erasure_request", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
