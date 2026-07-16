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
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import {
  ADMISSION_REVIEW_CHAIN,
  type AdmissionApplicationDto,
  type AdmissionApprovalDto,
  type AdmissionDetails,
  type AdmissionStage,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import {
  NOTIFICATION_CHANNEL_PROVIDER,
  type NotificationChannelProvider,
} from "../notifications/notification.constants";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { computePlatformFeeMinor } from "@sms/types";
import { PaystackService, type PaystackEvent } from "../payments/paystack.service";
import { PlatformFeeService } from "../billing/platform-fee.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

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
  createdAt: Date;
}

@Injectable()
export class AdmissionsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER) private readonly channel: NotificationChannelProvider,
    private readonly paystack: PaystackService,
    private readonly platformFees: PlatformFeeService,
    private readonly privileged: PrivilegedDatabaseService,
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

    const created = await this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, (tx) =>
      tx.admissionApplication.create({
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
          // Initialise the maker-checker chain (Admin → HR → Principal).
          stages: ADMISSION_REVIEW_CHAIN as unknown as Prisma.InputJsonValue,
          currentStage: 0,
          approvals: [] as unknown as Prisma.InputJsonValue,
          status: "NEW",
        },
        select: { id: true, status: true },
      }),
    );

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
    const { authorizationUrl } = await this.paystack.initialize({
      email,
      amountMinor: feeMinor,
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

      await tx.admissionApplication.update({
        where: { id },
        data: {
          status: status as "NEW" | "REVIEWING" | "ACCEPTED" | "REJECTED",
          currentStage,
          approvals: nextApprovals as unknown as Prisma.InputJsonValue,
          reviewedById: p.userId,
          reviewNote: note ?? null,
        },
      });
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
      await this.notifyApplicant(result.app, result.status);
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

  /** Best-effort email to the (non-user) applicant. Never throws into the request. */
  private async notifyApplicant(app: AppRow, status: string): Promise<void> {
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
    const body = accepted
      ? `Good news — the application for ${app.childName} has been accepted.${examLine}`
      : `Thank you for your application for ${app.childName}. After review, it was not successful at this time.`;
    try {
      await this.channel.deliver({ channel: "EMAIL", target: app.applicantEmail, title, body });
    } catch {
      // Communication is best-effort; the decision itself is already committed.
    }
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
      createdAt: r.createdAt,
    };
  }
}
