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
import { PRIVACY_PERMISSIONS, subjectRequestTarget } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";

const DAY_MS = 86_400_000;
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
    // The school's compliance regime decides how long there is to answer.
    private readonly region: SchoolRegionService,
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
    const [
      enrollments,
      attendance,
      invoices,
      documents,
      notifications,
      grades,
      remarks,
      traitRatings,
      subjectSelections,
      guardians,
      credits,
      virtualAccounts,
      consents,
      exemptions,
    ] = await Promise.all([
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
      // WHAT THE SCHOOL HAS WRITTEN ABOUT THE CHILD.
      //
      // Remarks and trait ratings are OPINION data — a class teacher's written
      // comment, a rating of a child's character — and a right of access covers
      // opinions about the subject as squarely as it covers facts. The family
      // already reads the remarks on every report card, so withholding them from
      // the bundle protected nothing and made the bundle wrong.
      tx.reportCardRemark.findMany({ where: { studentId }, orderBy: { updatedAt: "desc" } }),
      tx.studentTraitRating.findMany({ where: { studentId }, orderBy: { updatedAt: "desc" } }),
      // The subjects they offer, and who the school records as their guardians —
      // a relationship held ABOUT the pupil, which they are entitled to see.
      tx.subjectSelection.findMany({ where: { studentId } }),
      tx.parentChild.findMany({ where: { studentId }, select: { id: true, parentId: true, createdAt: true } }),
      // Money held in their name, and the account number issued for them.
      tx.studentCreditEntry.findMany({ where: { studentId }, orderBy: { createdAt: "desc" } }),
      tx.studentVirtualAccount.findMany({
        where: { studentId },
        select: { id: true, bankName: true, accountNumber: true, createdAt: true },
      }),
      // Consent and accommodation records — the pupil's own, and the two things
      // a family is most likely to want proof of.
      tx.integrityConsent.findMany({ where: { studentId } }),
      tx.studentIntegrityExemption.findMany({ where: { studentId } }),
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
      remarks,
      traitRatings,
      subjectSelections,
      guardians,
      credits,
      virtualAccounts,
      consents,
      exemptions,
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
          "remarks",
          "traitRatings",
          "subjectSelections",
          "guardians",
          "credits",
          "virtualAccounts",
          "consents",
          "exemptions",
        ],
        // And what is NOT, with the reason. Integrity telemetry is about this
        // pupil and is deliberately not served to families here: the platform's
        // rule is that raw signals go to a teacher for human judgement, never to
        // a parent as a verdict (Golden Rule #8). Saying so beats omitting it
        // silently — a data subject can then ask the school for it directly.
        // AND WHAT IS NOT, EVERY CATEGORY OF IT, WITH A REASON.
        //
        // This list used to name one exclusion while the bundle silently read 8
        // of the 33 tables keyed on a pupil. `complete: true` beside a named
        // section list reads as "this is everything", which is the ambiguity the
        // manifest was written to remove — and it had simply been left one level
        // up, at the level of whole categories rather than of fields.
        //
        // Everything below is a DECISION, not an omission, and
        // `every-student-table-is-accounted-for.spec.ts` computes the set of
        // student-keyed tables from the live schema and fails if one is neither
        // exported nor named here. A new table cannot go missing quietly.
        excluded: [
          {
            section: "integritySignals",
            reason:
              "Assessment-integrity signals are held for human review by school staff and are not released through this bundle. Ask the school's data controller for them.",
          },
          {
            section: "learningActivity",
            reason:
              "Coursework attempts, quiz attempts, lesson progress, live-lesson attendance, badges and CBT sittings are the working record of lessons in progress. The RESULTS that come out of them are in `grades`, which is what the pupil is assessed on. Ask the school's data controller for the underlying attempts.",
          },
          {
            section: "boardingAndTransport",
            reason:
              "Hostel allocation, hostel attendance and exeat records are held by the boarding house. Ask the school's data controller for them.",
          },
          {
            section: "examLogistics",
            reason:
              "Seat allocations and exam-hall attendance are operational scheduling records rather than a finding about the pupil. Ask the school's data controller for them.",
          },
          {
            section: "meetings",
            reason:
              "Parent-teacher meeting bookings and requests are held against the guardian who made them. A guardian can see their own in the meetings area.",
          },
          {
            section: "scholarshipApplications",
            reason:
              "A scholarship application is made by the family and visible to them in the scholarships area; it also carries a snapshot of signals about other pupils' rankings, so it is not reproduced here.",
          },
          {
            section: "derivedSummaries",
            reason:
              "Attendance term rollups are recalculated from the attendance rows already included in this bundle, so they add nothing a reader cannot see.",
          },
          {
            section: "erasureRequests",
            reason:
              "Requests made under this same right are governance records of the request itself, not data about the pupil. The school's data controller holds them.",
          },
          {
            section: "crossSchoolCompetition",
            reason:
              "Cross-school arena consent is recorded per pupil; the arena itself holds only a pseudonymous handle and never the pupil's name.",
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

  /**
   * Erasure requests, each carrying HOW LONG IT HAS BEEN WAITING.
   *
   * Answering a data subject is time-bound, and the row said only when it
   * arrived — leaving the person responsible to do the arithmetic on every line
   * and to know the period from memory. The breach register beside it has
   * computed `notifyDueAt` / `overdue` / `deadlineIsStatutory` since it was
   * built; the same clock simply was not applied here.
   *
   * `deadlineIsStatutory` is the honest half. Only a period this platform has
   * actually recorded for the school's regime counts as law; everything else is
   * a good-practice target the screen must label as such, so a countdown never
   * poses as a legal deadline for a country whose rule nobody looked up.
   */
  async listErasureRequests(p: Principal) {
    const canReview = p.permissions.includes("privacy.erasure.review");
    const rows = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.erasureRequest.findMany({
        where: canReview ? {} : { requestedById: p.userId },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
    // The same accessor the breach register uses, so the two clocks can never
    // read a different regime for one school.
    const regime = (await this.region.forSchool(p.schoolId)).compliance;
    const target = subjectRequestTarget(regime);
    const now = Date.now();
    return (rows as Array<{ id: string; studentId: string; reason: string; status: string; createdAt: Date }>).map((r) => {
      const dueAt = new Date(r.createdAt.getTime() + target.days * DAY_MS);
      // A DECIDED request has no clock left to run. Showing one still ticking
      // beside an answered request is how a register trains its reader to
      // ignore the column.
      const open = r.status === "PENDING";
      return {
        ...r,
        dueAt,
        daysRemaining: open ? Math.ceil((dueAt.getTime() - now) / DAY_MS) : null,
        overdue: open && now > dueAt.getTime(),
        deadlineIsStatutory: target.statutory,
        targetDays: target.days,
      };
    });
  }

  async reviewErasure(p: Principal, id: string, decision: "APPROVED" | "REJECTED", note?: string) {
    const { updated, fileKeys, outcome, requestedById } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
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
      let suppliedKeys: string[] = [];
      let retainedVaultDocs = 0;
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

        // AND THE FILES THE FAMILY THEMSELVES SUPPLIED.
        //
        // Erasure used to reach assignment uploads and nothing else. A child's
        // birth certificate, immunisation record and passport photograph are
        // supplied through `DocumentSubmission` — more sensitive than any
        // homework PDF, and left in object storage while the request was marked
        // APPROVED and the audit row said the files were erased.
        //
        // Two ways they attach to one child, and BOTH are needed:
        //   STUDENT               keyed directly on the pupil;
        //   ADMISSION_APPLICATION keyed on the application, which carries
        //                         `convertedStudentId` once the pupil is
        //                         enrolled — the link that already exists so the
        //                         two records are not orphans of each other.
        //
        // The declined-applicant sweep does NOT cover these: it purges REJECTED
        // applications on a timer, so an enrolled pupil's documents were reached
        // by no path at all.
        const applications = await tx.admissionApplication.findMany({
          where: { convertedStudentId: req.studentId },
          select: { id: true },
        });
        const subjectFilter = [
          { subjectKind: "STUDENT", subjectId: req.studentId },
          ...(applications.length > 0
            ? [{ subjectKind: "ADMISSION_APPLICATION", subjectId: { in: applications.map((a) => a.id) } }]
            : []),
        ];
        const supplied = await tx.documentSubmission.findMany({
          where: { OR: subjectFilter, storageKey: { not: null } },
          select: { id: true, storageKey: true },
        });
        suppliedKeys = supplied.map((d) => d.storageKey).filter((k): k is string => Boolean(k));
        if (supplied.length > 0) {
          await tx.documentSubmission.updateMany({
            where: { id: { in: supplied.map((d) => d.id) } },
            data: { storageKey: null, originalName: null, contentType: null, sizeBytes: null },
          });
        }

        // WHAT IS DELIBERATELY KEPT IS COUNTED, NOT PASSED OVER IN SILENCE.
        //
        // Document Vault entries — report cards, receipts, certificates — are the
        // SCHOOL's own record of the pupil, kept on the same reasoning as the
        // submission row and the grade beside it. That is a defensible decision
        // and a bad secret: a family asking "have you deleted my child's records"
        // deserves to be told what remains and why, and a controller signing the
        // request off should see it before they sign.
        retainedVaultDocs = await tx.document.count({ where: { studentId: req.studentId } });
      }

      await this.log(tx, p, `privacy.erasure.${decision.toLowerCase()}`, id, {
        studentId: req.studentId,
        ...(decision === "APPROVED"
          ? {
              erasedSubmissionFiles: fileKeys.length,
              erasedSuppliedDocuments: suppliedKeys.length,
              retainedVaultDocuments: retainedVaultDocs,
              retainedReason: retainedVaultDocs > 0 ? "school record (report cards, receipts, certificates)" : null,
            }
          : {}),
      });
      return {
        updated,
        requestedById: req.requestedById as string,
        fileKeys: [...fileKeys, ...suppliedKeys],
        outcome: {
          erasedSubmissionFiles: fileKeys.length,
          erasedSuppliedDocuments: suppliedKeys.length,
          retainedVaultDocuments: retainedVaultDocs,
        },
      };
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
    // AND SO IS THE PERSON WHO ASKED.
    //
    // A right to erasure is a right to an ANSWER, which is the whole reason
    // `listErasureRequests` computes `dueAt` / `daysRemaining` / `overdue` /
    // `deadlineIsStatutory` off the school's own compliance regime. Deciding
    // the request STOPS that clock — `daysRemaining` goes null the moment the
    // status leaves PENDING — and nothing told the subject. The register read
    // "answered within the period" while the family had heard nothing.
    //
    // Raising one already notified the controller. Every sibling decision in
    // this codebase closes the loop the other way: a meeting request answers
    // "Your meeting request was accepted", a scholarship tells the guardian at
    // every stage. This was the outlier, and it is the one with a deadline in
    // law behind it.
    //
    // TO THE REQUESTER, not to the pupil's guardians. Staff may raise an
    // erasure themselves, and telling a family about a request they did not
    // make discloses something they were not party to.
    if (requestedById && requestedById !== p.userId) {
      const kept =
        outcome.retainedVaultDocuments > 0
          ? ` The school keeps ${outcome.retainedVaultDocuments} record${outcome.retainedVaultDocuments === 1 ? "" : "s"} of its own (report cards, receipts, certificates) as it is required to.`
          : "";
      await this.notifications
        .enqueue(this.ctx(p), {
          recipientId: requestedById,
          type: "WORKFLOW_UPDATE",
          title: decision === "APPROVED" ? "Your erasure request was approved" : "Your erasure request was declined",
          body:
            decision === "APPROVED"
              ? `${outcome.erasedSubmissionFiles + outcome.erasedSuppliedDocuments} uploaded file(s) have been erased.${kept}`
              : `The school has declined the request.${note ? ` Reason: ${note}` : ""}`,
          data: { erasureRequestId: id, decision },
        } as never)
        // The decision is made and recorded; losing it because the notice
        // failed would be worse than a notice that did not arrive. It is
        // logged, not swallowed — an unanswered subject is the failure this
        // whole block exists to prevent.
        .catch((err: Error) => this.logger.error(`erasure ${id}: could not notify the requester: ${err.message}`));
    }

    // THE PERSON WHO SIGNED IT OFF IS TOLD WHAT HAPPENED.
    //
    // The audit row carries this either way, and that is the record a regulator
    // would read. But the controller approving the request is the one who has to
    // answer the family, and until now the screen simply refreshed: no count of
    // what was erased and no mention that the school's own vault records remain.
    // "Report what you did not do", at the moment of deciding rather than only in
    // a log somebody has to go and look for.
    return { ...updated, ...outcome, storageFailures: failedKeys.length };
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
