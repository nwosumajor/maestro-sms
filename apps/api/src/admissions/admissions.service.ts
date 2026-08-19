// =============================================================================
// AdmissionsService — public enrolment intake + on-application maker-checker
// =============================================================================
// The PUBLIC submit resolves the school by SLUG (the School registry is
// RLS-exempt, so readable without tenant context), then inserts into the school's
// quarantined applications with the RLS GUC set to that resolved school — never to
// client-supplied data. Applications never touch the student/user tables.
//
// REVIEW is a 3-stage maker-checker (School admin → HR → Principal) recorded ON
// the application (the applicant is not a system user, so we cannot use the generic
// WorkflowRequest engine whose initiator is a required user FK). Each stage needs a
// DIFFERENT staff member holding that stage's granular permission. On final
// approval the application is ACCEPTED and the entrance-exam date is communicated
// to the applicant by email (best-effort, via the pluggable channel provider).
// =============================================================================

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  ADMISSION_REVIEW_CHAIN,
  type AdmissionApplicationDto,
  type AdmissionApprovalDto,
  type AdmissionDetails,
  type AdmissionStage,
  PAYMENT_CHANNELS,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantTx,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import {
  NOTIFICATION_CHANNEL_PROVIDER,
  type NotificationChannelProvider,
} from "../notifications/notification.constants";
import { BadRequestException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { computePlatformFeeMinor, UPLOAD_TOKEN_TTL_DAYS } from "@sms/types";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { PlatformFeeService } from "../billing/platform-fee.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { PaymentChannelService } from "../payments/payment-channel.service";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { allocateLoginEmail, schoolSlugOf } from "../foundation/login-email";
import { allocateAdmissionNumber, loadUsedAdmissionNumbers, schoolAdmissionYear } from "../foundation/admission-number";
import { SuppliedDocumentsService } from "../documents/supplied-documents.service";
import { mintDocumentUploadToken } from "../documents/document-upload-token";

const ZERO = "00000000-0000-0000-0000-000000000000";

export interface AdmissionInput {
  schoolSlug: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string | null;
  childName: string;
  childDob?: string | null;
  desiredClass?: string | null;
  notes?: string | null;
  details?: AdmissionDetails | null;
}

interface AppRow {
  id: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  childName: string;
  childDob: Date | null;
  desiredClass: string | null;
  status: string;
  details: unknown;
  stages: unknown;
  currentStage: number;
  approvals: unknown;
  examDate: Date | null;
  examNote: string | null;
  reviewNote: string | null;
  formFeeMinor: number;
  formFeePaidAt: Date | null;
  convertedStudentId?: string | null;
  createdAt: Date;
}

@Injectable()
export class AdmissionsService {
  private readonly logger = new Logger("Admissions");
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER) private readonly channel: NotificationChannelProvider,
    private readonly paystack: PaystackService,
    private readonly platformFees: PlatformFeeService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly region: SchoolRegionService,
    // The documents an accepted family already sent, so they follow the child
    // onto the roll in the SAME transaction that creates them.
    private readonly supplied: SuppliedDocumentsService,
    // LAST and @Optional deliberately. DI always provides it in the running
    // app; being optional keeps every existing unit wiring compiling, and
    // absent it FAILS OPEN — a missing switchboard must never be the reason a
    // parent cannot pay. It gates a commercial choice, not a security boundary.
    @Optional() private readonly channels?: PaymentChannelService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** PUBLIC: submit a comprehensive enrolment application to a school by slug. */
  async submit(input: AdmissionInput) {
    // School is RLS-exempt, so we can resolve the slug under a placeholder GUC.
    const school = await this.db.runAsTenant<
      { id: string; admissionFormFeeMinor: number; paystackSubaccountCode: string | null } | null
    >({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.school.findFirst({
        where: { slug: input.schoolSlug, status: "ACTIVE", isPlatform: false },
        select: { id: true, admissionFormFeeMinor: true, paystackSubaccountCode: true },
      }),
    );
    if (!school) throw new NotFoundException("School not found");

    // Snapshot the form fee at submission — a later fee change never affects an
    // in-flight application. The fee is only collectable online, so it applies
    // only while the gateway is configured.
    const formFeeMinor = this.paystack.isConfigured() ? Math.max(0, school.admissionFormFeeMinor) : 0;

    const created = await this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, async (tx) => {
      const stages = await this.resolveChain(tx);
      return tx.admissionApplication.create({
        data: {
          schoolId: school.id,
          applicantName: input.applicantName,
          applicantEmail: input.applicantEmail,
          applicantPhone: input.applicantPhone ?? null,
          childName: input.childName,
          childDob: input.childDob ? new Date(input.childDob) : null,
          desiredClass: input.desiredClass ?? input.details?.desiredClass ?? null,
          notes: input.notes ?? input.details?.notes ?? null,
          details: input.details ? (input.details as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          formFeeMinor,
          // The maker-checker chain (Admin → HR → Principal), narrowed to the
          // stages this school has somebody to decide.
          stages: stages as unknown as Prisma.InputJsonValue,
          currentStage: 0,
          approvals: [] as unknown as Prisma.InputJsonValue,
          status: "NEW",
        },
        select: { id: true, status: true },
      });
    });

    // Fee due → hand the applicant straight to the hosted checkout. A failure
    // here never loses the application: the public retry init covers it.
    if (formFeeMinor > 0) {
      try {
        const pay = await this.initFormFeeCharge(school.id, created.id, input.applicantEmail, formFeeMinor, school.paystackSubaccountCode);
        return { ...created, formFeeMinor, payment: pay };
      } catch {
        return { ...created, formFeeMinor, payment: null };
      }
    }
    return { ...created, formFeeMinor, payment: null };
  }

  /** PUBLIC: (re)start the hosted checkout for an application's form fee — the
   *  applicant may have abandoned the first redirect. The application id is an
   *  unguessable uuid; the slug scopes the tenant lookup. */
  async initFormFeePayment(schoolSlug: string, applicationId: string) {
    if (!this.paystack.isConfigured()) {
      throw new ServiceUnavailableException("Online payments are not configured");
    }
    const school = await this.db.runAsTenant<
      { id: string; paystackSubaccountCode: string | null } | null
    >({ schoolId: ZERO, userId: ZERO }, (tx) =>
      tx.school.findFirst({
        where: { slug: schoolSlug, status: "ACTIVE", isPlatform: false },
        select: { id: true, paystackSubaccountCode: true },
      }),
    );
    if (!school) throw new NotFoundException("School not found");
    const app = await this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, (tx) =>
      tx.admissionApplication.findFirst({
        where: { id: applicationId },
        select: { id: true, applicantEmail: true, formFeeMinor: true, formFeePaidAt: true },
      }),
    );
    if (!app) throw new NotFoundException("Application not found");
    if (app.formFeeMinor <= 0) throw new BadRequestException("This application has no form fee");
    if (app.formFeePaidAt) throw new ConflictException("The form fee is already paid");
    return this.initFormFeeCharge(school.id, app.id, app.applicantEmail, app.formFeeMinor, school.paystackSubaccountCode);
  }

  /** Start the Paystack charge for a form fee: settles to the school's bank
   *  (split) with the platform's take-rate applied — the same rails as fee
   *  collection. The applicant always bears their own form fee. */
  private async initFormFeeCharge(
    schoolId: string,
    applicationId: string,
    email: string,
    feeMinor: number,
    subaccount: string | null,
  ): Promise<{ authorizationUrl: string; reference: string; amountMinor: number }> {
    const cfg = await this.platformFees.effective();
    const platformTake = subaccount ? computePlatformFeeMinor(feeMinor, cfg) : 0;
    const reference = `ADM-${applicationId.slice(0, 8)}-${Date.now()}`;
    // The SCHOOL's currency — the admission fee is the school's money, and
    // `school.admissionFormFeeMinor` is denominated in it.
    const { currency } = await this.region.forSchool(schoolId);
    await this.channels?.assertEnabled(PAYMENT_CHANNELS.PAYSTACK);
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor: feeMinor,
      currency,
      reference,
      metadata: { kind: "admission_form", applicationId, schoolId },
      subaccount: subaccount ?? undefined,
      bearer: "subaccount",
      transactionChargeMinor: platformTake,
    });
    return { authorizationUrl, reference, amountMinor: feeMinor };
  }

  /** Verified webhook (dispatched by metadata.kind === "admission_form"):
   *  mark the application's form fee paid. Idempotent on the gateway reference.
   *  No audit entry: the actor is the anonymous applicant (no user FK) — the
   *  same posture as the public careers intake. */
  async applyFormFeePayment(event: PaystackEvent): Promise<{ ok: boolean }> {
    if (event.event !== "charge.success") return { ok: true };
    const { applicationId, schoolId } = (event.data.metadata ?? {}) as { applicationId?: string; schoolId?: string };
    if (!applicationId || !schoolId) return { ok: true };
    await this.db.runAsTenant({ schoolId, userId: ZERO }, async (tx) => {
      // Idempotent: only the FIRST successful charge stamps the fee.
      await tx.admissionApplication.updateMany({
        where: { id: applicationId, formFeePaidAt: null },
        data: { formFeePaidAt: new Date(), formFeeRef: event.data.reference },
      });
    });
    return { ok: true };
  }

  /** The school's current admission-form fee (staff view). */
  async getFormFee(p: Principal): Promise<{ formFeeMinor: number }> {
    const row = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.school.findFirst({ where: { id: p.schoolId }, select: { admissionFormFeeMinor: true } }),
    );
    return { formFeeMinor: row?.admissionFormFeeMinor ?? 0 };
  }

  /** Finance staff set the school's admission-form fee (kobo; 0 = free).
   *  Global-registry write → PRIVILEGED client (same posture as settlement). */
  async setFormFee(p: Principal, feeMinor: number): Promise<{ formFeeMinor: number }> {
    if (!Number.isInteger(feeMinor) || feeMinor < 0 || feeMinor > 100_000_000) {
      throw new BadRequestException("feeMinor must be an integer 0–100,000,000 (kobo)");
    }
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Fee management requires the privileged database configuration");
    }
    await client.school.update({ where: { id: p.schoolId }, data: { admissionFormFeeMinor: feeMinor } });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "admission.form_fee.set",
          entity: "school",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { feeMinor },
        },
        tx,
      ),
    );
    return { formFeeMinor: feeMinor };
  }

  async list(p: Principal): Promise<AdmissionApplicationDto[]> {
    const rows = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.admissionApplication.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    );
    return (rows as unknown as AppRow[]).map((r) => this.toDto(r));
  }

  async get(p: Principal, id: string): Promise<AdmissionApplicationDto> {
    const row = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.admissionApplication.findFirst({ where: { id } }),
    );
    if (!row) throw new NotFoundException("Application not found");
    return this.toDto(row as unknown as AppRow);
  }

  /**
   * Decide the current maker-checker stage. The actor must hold the stage's
   * granular permission AND must not have decided an earlier stage (separation of
   * duties). APPROVE on the last stage ACCEPTS the application; REJECT at any stage
   * is terminal. On a terminal decision the applicant is emailed (best-effort).
   */
  async review(p: Principal, id: string, action: "APPROVE" | "REJECT", note?: string) {
    const result = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = (await tx.admissionApplication.findFirst({ where: { id } })) as AppRow | null;
      if (!app) throw new NotFoundException("Application not found");
      if (app.status === "ACCEPTED" || app.status === "REJECTED") {
        throw new ConflictException("Application already decided");
      }

      const stages = this.stagesOf(app);
      const approvals = (app.approvals as AdmissionApprovalDto[] | null) ?? [];
      const stage = stages[app.currentStage];
      if (!stage) throw new ConflictException("No active review stage");

      // The actor must hold THIS stage's granular permission…
      if (!p.permissions.includes(stage.permission)) {
        throw new ForbiddenException(`You are not the ${stage.label} approver`);
      }
      // …and must not have already decided a stage on this application (SoD).
      if (approvals.some((a) => a.approverId === p.userId)) {
        throw new ForbiddenException("You have already acted on this application");
      }

      // SECURITY/SAFETY: approving here must not make the REST of the chain
      // impossible. `admission.review` is held by principal and hr_manager as
      // well as the admin roles, while each later stage has exactly one role —
      // so a principal helpfully clearing the intake queue spent the only
      // signature stage 2 would ever have, and the application stuck at
      // REVIEWING for ever with no reassign, no reset and no way out. Refuse
      // where it is still recoverable, and say what to do instead.
      if (action === "APPROVE") {
        for (const later of stages.slice(app.currentStage + 1)) {
          if ((await this.approverCount(tx, later.permission, p.userId)) === 0) {
            throw new ConflictException(
              `You are the only ${later.label} approver, and each stage must be decided by a different person. ` +
                `Approving here would leave nobody able to complete this application — leave the ${stage.label} ` +
                `stage to a colleague, or appoint another ${later.label}.`,
            );
          }
        }
      }

      const record: AdmissionApprovalDto = {
        stageKey: stage.key,
        approverId: p.userId,
        decision: action,
        at: new Date().toISOString(),
      };
      const nextApprovals = [...approvals, record];

      let status = app.status;
      let currentStage = app.currentStage;
      if (action === "REJECT") {
        status = "REJECTED";
      } else if (app.currentStage >= stages.length - 1) {
        status = "ACCEPTED"; // final stage approved
      } else {
        status = "REVIEWING";
        currentStage = app.currentStage + 1;
      }

      // Optimistic write on (status, currentStage) — the same guard the workflow
      // engine carries, and for the same reason. Two approvers deciding the same
      // stage at once both read `approvals: []`, both pass the SoD check and
      // both write: one approval record is silently lost, and the approver whose
      // record vanished is then free to decide a LATER stage as well. The lost
      // write is a bookkeeping bug; the separation of duties it defeats is not.
      const written = await tx.admissionApplication.updateMany({
        where: {
          id,
          status: app.status as "NEW" | "REVIEWING" | "ACCEPTED" | "REJECTED",
          currentStage: app.currentStage,
        },
        data: {
          status: status as "NEW" | "REVIEWING" | "ACCEPTED" | "REJECTED",
          currentStage,
          approvals: nextApprovals as unknown as Prisma.InputJsonValue,
          reviewedById: p.userId,
          reviewNote: note ?? null,
        },
      });
      if (written.count === 0) {
        throw new ConflictException("Somebody else reviewed this application a moment ago — reopen it to see where it stands");
      }
      await this.audit.record(
        {
          actorId: p.userId,
          action: `admission.${action.toLowerCase()}`,
          entity: "admission_application",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { stageKey: stage.key, status },
        },
        tx,
      );
      return { id, status, currentStage, terminal: status === "ACCEPTED" || status === "REJECTED", app };
    });

    if (result.terminal) {
      await this.notifyApplicant(result.app, result.status, p.schoolId);
    }
    return { id: result.id, status: result.status, currentStage: result.currentStage };
  }

  /** Set / update the entrance-exam schedule (communicated to the applicant on acceptance). */
  async setExam(
    p: Principal,
    id: string,
    input: { examDate?: string | null; examNote?: string | null; desiredClass?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const app = await tx.admissionApplication.findFirst({ where: { id }, select: { id: true } });
      if (!app) throw new NotFoundException("Application not found");
      const updated = await tx.admissionApplication.update({
        where: { id },
        data: {
          examDate: input.examDate ? new Date(input.examDate) : input.examDate === null ? null : undefined,
          examNote: input.examNote ?? undefined,
          desiredClass: input.desiredClass ?? undefined,
        },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "admission.exam.set",
          entity: "admission_application",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { examDate: input.examDate ?? null },
        },
        tx,
      );
      return this.toDto(updated as unknown as AppRow);
    });
  }

  // --- helpers ---------------------------------------------------------------
  private stagesOf(app: AppRow): AdmissionStage[] {
    const s = (app.stages as AdmissionStage[] | null) ?? [];
    return s.length > 0 ? s : ADMISSION_REVIEW_CHAIN;
  }

  /**
   * How many ACTIVE people in this school could decide this stage.
   *
   * The chain is Admin → HR → Principal, but a school is not obliged to employ
   * an HR manager, and `workflow.review.hr` has exactly one role holding it. A
   * live tenant had ZERO holders: every application that school received could
   * pass stage 0 and then stalled at stage 1 for ever, form fee already taken,
   * with no person on earth able to advance it.
   */
  private async approverCount(tx: TenantTx, permission: string, excludeUserId?: string): Promise<number> {
    return tx.user.count({
      where: {
        status: "ACTIVE",
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
        roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
      },
    });
  }

  /**
   * The chain this school can actually staff.
   *
   * A stage nobody can decide is not a control — it is a dead end that stops the
   * ones after it from ever being reached. Dropping it is recorded on the row
   * (the resolved chain is what `stages` stores), so the review screen shows the
   * route an application will really take rather than an aspirational one.
   *
   * If NOTHING can be staffed we keep the full chain: an application that cannot
   * be reviewed must stay unreviewed, never sail through by default.
   */
  private async resolveChain(tx: TenantTx): Promise<AdmissionStage[]> {
    const staffed: AdmissionStage[] = [];
    for (const stage of ADMISSION_REVIEW_CHAIN) {
      if ((await this.approverCount(tx, stage.permission)) > 0) staffed.push(stage);
    }
    return staffed.length > 0 ? staffed : ADMISSION_REVIEW_CHAIN;
  }

  /** Best-effort email to the (non-user) applicant. Never throws into the request. */
  private async notifyApplicant(app: AppRow, status: string, schoolId: string): Promise<void> {
    const accepted = status === "ACCEPTED";
    const title = accepted
      ? `Admission update for ${app.childName}: accepted`
      : `Admission update for ${app.childName}`;
    const examLine =
      accepted && app.examDate
        ? ` The entrance exam is scheduled for ${app.examDate.toISOString().slice(0, 10)}${
            app.examNote ? ` — ${app.examNote}` : ""
          }.`
        : accepted
          ? " We will contact you shortly with the entrance-exam date."
          : "";
    // THE LINK THAT PUTS THE UPLOAD SURFACE IN A PARENT'S HANDS.
    //
    // Without it the whole thing is unreachable: the token, the public
    // endpoints, the page at /apply/documents and every check around them were
    // built, and nothing ever gave a family the URL. A capability nobody is
    // handed is the same as one that does not exist.
    //
    // It goes in the ACCEPTANCE email rather than an email of its own — a family
    // who has just been told yes will read one message, and the documents are
    // the next thing the school needs from them.
    const documentsLine = accepted ? this.documentsLine(app, schoolId) : "";
    const body = accepted
      ? `Good news — the application for ${app.childName} has been accepted.${examLine}${documentsLine}`
      : `Thank you for your application for ${app.childName}. After review, it was not successful at this time.`;
    try {
      await this.channel.deliver({ channel: "EMAIL", target: app.applicantEmail, title, body });
    } catch {
      // Communication is best-effort; the decision itself is already committed.
    }
  }

  /**
   * The line inviting the family to send their documents in.
   *
   * The token IS the credential, so the link is minted per application and
   * carries nothing else — see document-upload-token.ts for what it can and
   * cannot do. Thirty days, because a birth certificate may need a trip to a
   * registry office.
   *
   * Silent when PUBLIC_WEB_URL is unset rather than sending a family a link to
   * "undefined/apply/documents": half a URL is worse than no sentence.
   */
  private documentsLine(app: AppRow, schoolId: string): string {
    const base = process.env.PUBLIC_WEB_URL;
    if (!base) {
      this.logger.warn(
        `PUBLIC_WEB_URL is not set — the acceptance email for ${app.id} went out with no documents link, so the family has no way to send anything in.`,
      );
      return "";
    }
    const token = mintDocumentUploadToken(app.id, schoolId);
    return ` Please send us the documents we still need for ${app.childName}: ${base}/apply/documents?token=${token} — the link is personal to this application and works for ${UPLOAD_TOKEN_TTL_DAYS} days.`;
  }

  private toDto(r: AppRow): AdmissionApplicationDto {
    const stages = this.stagesOf(r);
    const approvals = (r.approvals as AdmissionApprovalDto[] | null) ?? [];
    const terminal = r.status === "ACCEPTED" || r.status === "REJECTED";
    return {
      id: r.id,
      applicantName: r.applicantName,
      applicantEmail: r.applicantEmail,
      applicantPhone: r.applicantPhone,
      childName: r.childName,
      childDob: r.childDob,
      desiredClass: r.desiredClass,
      status: r.status,
      details: (r.details as AdmissionDetails | null) ?? null,
      currentStage: r.currentStage,
      stageCount: stages.length,
      stageLabel: terminal ? null : (stages[r.currentStage]?.label ?? null),
      approvals,
      examDate: r.examDate,
      examNote: r.examNote,
      reviewNote: r.reviewNote,
      formFeeMinor: r.formFeeMinor,
      formFeePaidAt: r.formFeePaidAt,
      convertedStudentId: r.convertedStudentId ?? null,
      createdAt: r.createdAt,
    };
  }
  /**
   * The accepted family becomes a pupil on the roll.
   *
   * THIS DID NOT EXIST. An application could be reviewed, approved through the
   * whole maker-checker chain, have its entrance exam scheduled and its
   * documents collected — and then somebody typed the child into the system by
   * hand, with nothing tying the two records together. The paperwork the family
   * had already sent had nowhere to go, and no one could answer "which pupil is
   * this application?".
   *
   * ONE TRANSACTION, because enrolling somebody is one decision: the account,
   * the profile, the class place, the guardian's own login and the documents
   * either all happen or none do.
   *
   * IDEMPOTENT on `convertedStudentId`, which is UNIQUE — a second click cannot
   * produce a second child, and the answer to a repeat is the pupil already
   * created rather than an error.
   */
  async convertToPupil(
    p: Principal,
    applicationId: string,
    input: { classId?: string; linkGuardian?: boolean },
  ): Promise<{ studentId: string; alreadyConverted: boolean; credentials?: { name: string; email: string; tempPassword: string }; guardianCredentials?: { name: string; email: string; tempPassword: string } }> {
    // Read first, so an already-converted application costs no bcrypt at all.
    const existing = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) =>
      (await tx.admissionApplication.findFirst({
        where: { id: applicationId },
        select: { id: true, status: true, childName: true, applicantName: true, applicantEmail: true, convertedStudentId: true, details: true },
      })) as {
        id: string; status: string; childName: string; applicantName: string; applicantEmail: string;
        convertedStudentId: string | null; details: unknown;
      } | null,
    );
    if (!existing) throw new NotFoundException("Application not found");
    if (existing.convertedStudentId) {
      return { studentId: existing.convertedStudentId, alreadyConverted: true };
    }
    if (existing.status !== "ACCEPTED") {
      // Enrolling somebody the school has not accepted is not a slip to
      // tolerate — it is a child on the roll who was never admitted.
      throw new BadRequestException("Only an accepted application can be enrolled");
    }

    // BCRYPT OUTSIDE THE TRANSACTION. Two hashes at ~100ms each is a fifth of
    // Prisma's 5s interactive cap spent doing arithmetic; the bulk import learnt
    // this the same way.
    const pupilPassword = randomBytes(9).toString("base64url");
    const guardianPassword = randomBytes(9).toString("base64url");
    const [pupilHash, guardianHash] = await Promise.all([
      bcrypt.hash(pupilPassword, 10),
      bcrypt.hash(guardianPassword, 10),
    ]);

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Re-read INSIDE the transaction and claim the conversion with a
      // conditional update. Two registrars pressing the button at once would
      // otherwise both pass the check above and both create a child.
      const claimed = await tx.admissionApplication.updateMany({
        where: { id: applicationId, convertedStudentId: null, status: "ACCEPTED" },
        data: { convertedAt: new Date() },
      });
      if (claimed.count === 0) {
        const now = (await tx.admissionApplication.findFirst({
          where: { id: applicationId },
          select: { convertedStudentId: true },
        })) as { convertedStudentId: string | null } | null;
        if (now?.convertedStudentId) return { studentId: now.convertedStudentId, alreadyConverted: true };
        throw new BadRequestException("Only an accepted application can be enrolled");
      }

      const studentRole = await tx.role.findFirst({ where: { name: "student" }, select: { id: true } });
      const parentRole = await tx.role.findFirst({ where: { name: "parent" }, select: { id: true } });
      if (!studentRole) throw new NotFoundException("student role missing");

      const slug = await schoolSlugOf(tx, p.schoolId);
      // A child gets a generated sign-in identifier: the application carries the
      // PARENT's address, and a pupil must not share a login with their guardian.
      const pupilEmail = await allocateLoginEmail(tx, existing.childName, slug, { autoSuffix: true });
      const year = await schoolAdmissionYear(tx, p.schoolId);
      const used = await loadUsedAdmissionNumbers(tx, year);
      const admissionNumber = allocateAdmissionNumber(used, year);

      const pupil = await tx.user.create({
        data: {
          schoolId: p.schoolId,
          email: pupilEmail,
          loginEmailGenerated: true,
          name: existing.childName,
          passwordHash: pupilHash,
          // null => the login flow treats it as expired and the child sets their
          // own at first sign-in.
          passwordChangedAt: null,
        },
      });
      await tx.userRole.create({ data: { schoolId: p.schoolId, userId: pupil.id, roleId: studentRole.id } });
      const details = (existing.details ?? {}) as { dateOfBirth?: string; gender?: string };
      await tx.studentProfile.create({
        data: {
          schoolId: p.schoolId,
          studentId: pupil.id,
          admissionNumber,
          dateOfBirth: details.dateOfBirth ? new Date(details.dateOfBirth) : null,
          gender: details.gender ?? null,
        },
      });
      if (input.classId) {
        await tx.enrollment.create({ data: { schoolId: p.schoolId, classId: input.classId, studentId: pupil.id } });
      }

      // THE GUARDIAN. The application already carries who applied and how to
      // reach them; without this they would be a name on a form with no way in,
      // and somebody would key them a second time.
      let guardianCredentials: { name: string; email: string; tempPassword: string } | undefined;
      if (input.linkGuardian !== false && parentRole) {
        const guardianEmail = existing.applicantEmail.trim().toLowerCase();
        let guardian = await tx.user.findFirst({ where: { email: guardianEmail }, select: { id: true } });
        if (!guardian) {
          guardian = await tx.user.create({
            data: {
              schoolId: p.schoolId,
              email: guardianEmail,
              name: existing.applicantName,
              passwordHash: guardianHash,
              passwordChangedAt: null,
            },
          });
          await tx.userRole.create({ data: { schoolId: p.schoolId, userId: guardian.id, roleId: parentRole.id } });
          guardianCredentials = { name: existing.applicantName, email: guardianEmail, tempPassword: guardianPassword };
        }
        await tx.parentChild.create({
          data: { schoolId: p.schoolId, parentId: guardian.id, studentId: pupil.id, relationship: "GUARDIAN" },
        });
      }

      // The documents they sent follow them, in this same transaction.
      await this.supplied.promoteApplicationInTx(tx, {
        schoolId: p.schoolId,
        actorId: p.userId,
        applicationId,
        studentId: pupil.id,
      });

      await tx.admissionApplication.update({
        where: { id: applicationId },
        data: { convertedStudentId: pupil.id },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "admission.convert",
          entity: "admission_application",
          entityId: applicationId,
          schoolId: p.schoolId,
          metadata: { studentId: pupil.id, admissionNumber, classId: input.classId ?? null },
        },
        tx,
      );

      return {
        studentId: pupil.id,
        alreadyConverted: false,
        // Returned ONCE, like the bulk import's login slips. Nothing stores a
        // temporary password, and both accounts must change it at first sign-in.
        credentials: { name: existing.childName, email: pupilEmail, tempPassword: pupilPassword },
        guardianCredentials,
      };
    });
  }

}
