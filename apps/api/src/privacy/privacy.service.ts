// =============================================================================
// PrivacyService — NDPR data-subject rights: export + erasure requests
// =============================================================================
// Export gathers a student's personal data across modules (RLS-scoped) into one
// bundle and audit-logs the disclosure. Medical fields are decrypted only if the
// caller may read them. Erasure is a governed request: raised by a subject/
// guardian, reviewed by a controller against retention obligations — never a
// one-click deletion of a minor's record.
// =============================================================================

import { NotificationService } from "../notifications/notification.service";
import { PRIVACY_PERMISSIONS } from "@sms/types";
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
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

const STAFF_WIDE = new Set(["school_admin", "principal"]);
const MEDICAL_FIELDS = ["bloodGroup", "allergies", "conditions", "medications", "dietaryNotes", "notes"];

@Injectable()
export class PrivacyService {
  private readonly logger = new Logger("Privacy");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- export ----------------------------------------------------------------
  async exportStudent(p: Principal, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertCanAccess(tx, p, studentId);
      const bundle = await this.collectStudentBundle(tx, studentId, {
        schoolId: p.schoolId,
        includeMedical: p.permissions.includes("student.medical.read"),
      });
      await this.log(tx, p, "privacy.export", studentId);
      return { exportedAt: new Date().toISOString(), exportedBy: p.userId, ...bundle };
    });
  }

  /**
   * Gather ONE student's cross-module personal data into a bundle, on an existing
   * tenant transaction. Reused by the tenant-scoped NDPR export AND the super_admin
   * cross-tenant bulk export (which runs under the TARGET school's context). The
   * caller owns the audit log. Medical is decrypted with the passed `schoolId`'s
   * per-tenant key and only when `includeMedical` (so it's opt-in, never leaked).
   *
   * COMPLETENESS IS THE CALLER'S CHOICE, because the two callers are answering
   * different questions. A data subject exercising RIGHT OF ACCESS is entitled
   * to their data, not to the most recent page of it, so that path passes no
   * limit. The operator's BULK dump collects up to 1,000 pupils in one response
   * and is an administrative convenience rather than a statutory answer, so it
   * bounds each pupil's notification history. Either way the bundle SAYS which
   * it is in `coverage` — silent truncation on a right-of-access artifact is
   * the actual defect, and it is invisible to whoever receives the file.
   */
  async collectStudentBundle(
    tx: TenantTx,
    studentId: string,
    opts: { schoolId: string; includeMedical: boolean; notificationLimit?: number },
  ) {
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
    if (profile && opts.includeMedical) {
      const m = await tx.medicalRecord.findFirst({ where: { profileId: profile.id } });
      if (m) {
        const dec: Record<string, unknown> = { ...m };
        for (const f of MEDICAL_FIELDS) {
          if (typeof dec[f] === "string") dec[f] = decryptField(dec[f] as string, opts.schoolId);
        }
        medical = dec;
      }
    }
    const [enrollments, attendance, invoices, documents, notifications, grades] = await Promise.all([
      tx.enrollment.findMany({ where: { studentId } }),
      tx.attendanceRecord.findMany({ where: { studentId }, orderBy: { createdAt: "desc" } }),
      tx.invoice.findMany({ where: { studentId }, include: { lineItems: true, payments: true } }),
      tx.document.findMany({
        where: { studentId },
        select: { id: true, type: true, title: true, status: true, createdAt: true },
      }),
      // Uncapped unless the CALLER asks for a bound. A hard `take: 100` here
      // truncated a right-of-access bundle SILENTLY — the recipient had no way
      // to tell a complete record from a clipped one — and it was the only
      // capped section, while attendance beside it already ships every row (195
      // for the busiest pupil in the demo school, ~2,300 over a career). One
      // pupil's history is bounded by their career and further bounded by
      // retention: READ notifications are purged on
      // READ_NOTIFICATION_RETENTION_DAYS, so what survives is recent plus
      // anything still unread.
      tx.notification.findMany({
        where: { recipientId: studentId },
        orderBy: { createdAt: "desc" },
        ...(opts.notificationLimit ? { take: opts.notificationLimit } : {}),
      }),
      // GRADES. A pupil's results are unambiguously their own personal data and
      // the family already reads them on every report card, yet the bundle
      // omitted them entirely — and said `complete: true` while doing so.
      // PUBLISHED only: a draft mark is the teacher's working note, not a
      // finding about the pupil, and the report card does not show it either.
      tx.subjectResult.findMany({
        where: { studentId, status: "PUBLISHED" },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    // A limit that was REACHED means there may be more; a limit that was not
    // reached means this is everything, so the bundle can still call itself
    // complete. Saying "possibly truncated" when nothing was cut would train a
    // reader to ignore the flag.
    const truncated = opts.notificationLimit !== undefined && notifications.length === opts.notificationLimit;
    const completenessNote = truncated
      ? `Notification history was limited to the ${opts.notificationLimit} most recent entries for this bulk export. Run the per-pupil data export for a complete record. Every other section is complete.`
      : "All sections are complete and untruncated.";

    return {
      student,
      profile,
      emergencyContacts: contacts,
      medical: medical ?? "(not included)",
      enrollments,
      attendance,
      invoices,
      documents,
      notifications,
      grades,
      // What this bundle does and does NOT contain, stated IN the artifact. A
      // recipient cannot otherwise tell whether "medical": "(not included)"
      // means the pupil has no record or that the exporter could not read one.
      coverage: {
        complete: !truncated,
        // The PERMISSION, not whether a row happened to exist — otherwise a
        // pupil with no medical record is indistinguishable from one whose
        // record the exporter was not allowed to read. That is the same
        // ambiguity this block exists to remove.
        medicalIncluded: opts.includeMedical,
        // WHAT IS IN HERE, named. `complete: true` used to mean "nothing was
        // truncated", which a recipient reads as "this is everything" — and
        // grades were missing from the bundle altogether.
        sections: [
          "student",
          "profile",
          "emergencyContacts",
          "medical",
          "enrollments",
          "attendance",
          "invoices",
          "documents",
          "notifications",
          "grades",
        ],
        // And what is NOT, with the reason. Integrity telemetry is about this
        // pupil and is deliberately not served to families here: the platform's
        // rule is that raw signals go to a teacher for human judgement, never to
        // a parent as a verdict (Golden Rule #8). Saying so beats omitting it
        // silently — a data subject can then ask the school for it directly.
        excluded: [
          {
            section: "integritySignals",
            reason:
              "Assessment-integrity signals are held for human review by school staff and are not released through this bundle. Ask the school's data controller for them.",
          },
        ],
        note: opts.includeMedical
          ? completenessNote
          : "Medical records are EXCLUDED from this export because the person who ran it does not hold student.medical.read — this is not a statement that the pupil has no medical record. Every other section is complete and untruncated.",
      },
    };
  }

  // --- erasure requests ------------------------------------------------------
  async requestErasure(p: Principal, input: { studentId: string; reason: string }) {
    const req = await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
    // A right-to-erasure request is a STATUTORY obligation with a response
    // deadline, and it was created silently — so the clock started on a record
    // nobody had been told about. The controller who must answer it is told now.
    await this.notifications.notifyPermissionHolders(
      this.ctx(p),
      PRIVACY_PERMISSIONS.ERASURE_REVIEW,
      {
        type: "WORKFLOW_UPDATE",
        title: "An erasure request needs a decision",
        body: "A data-erasure request has been made and is waiting for review.",
        data: { erasureRequestId: req.id },
      },
      { exclude: [p.userId] },
    );
    return req;
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

    // Delete the bytes after the tx commits — and RECORD what did not go.
    //
    // This used to be `.catch(() => undefined)`: a swallowed failure, on the one
    // operation whose whole purpose is that something ceases to exist. The row's
    // `fileKey` has already been nulled by then, so a failed delete leaves a
    // minor's file in object storage with NO pointer to it anywhere — orphaned,
    // unfindable, and unerasable — while the request reads APPROVED and the
    // audit says the files were erased. Asked by a regulator whether the data
    // was destroyed, the school's own evidence would have said yes.
    //
    // The decision stays APPROVED (it was made, and correctly). What changes is
    // that incomplete EXECUTION is written down, with the keys, in the
    // append-only log — so the objects can still be found and purged by hand.
    const failedKeys: string[] = [];
    for (const key of fileKeys) {
      try {
        await this.storage.delete(key);
      } catch (err) {
        failedKeys.push(key);
        this.logger.error(`erasure ${id}: storage delete failed for ${key}: ${(err as Error).message}`);
      }
    }
    if (failedKeys.length > 0) {
      await this.db
        .runAsTenant(this.ctx(p), (tx) =>
          this.log(tx, p, "privacy.erasure.incomplete", id, {
            failedKeys,
            failed: failedKeys.length,
            of: fileKeys.length,
          }),
        )
        // Even this must not throw: the erasure itself succeeded in the database,
        // and losing that because the follow-up record failed would be worse.
        .catch(() => this.logger.error(`erasure ${id}: could not record ${failedKeys.length} failed deletes`));
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
