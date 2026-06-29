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
  createdAt: Date;
}

@Injectable()
export class AdmissionsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER) private readonly channel: NotificationChannelProvider,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** PUBLIC: submit a comprehensive enrolment application to a school by slug. */
  async submit(input: AdmissionInput) {
    // School is RLS-exempt, so we can resolve the slug under a placeholder GUC.
    const school = await this.db.runAsTenant<{ id: string } | null>(
      { schoolId: ZERO, userId: ZERO },
      (tx) => tx.school.findFirst({ where: { slug: input.schoolSlug, status: "ACTIVE" }, select: { id: true } }),
    );
    if (!school) throw new NotFoundException("School not found");

    return this.db.runAsTenant({ schoolId: school.id, userId: ZERO }, (tx) =>
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
          // Initialise the maker-checker chain (Admin → HR → Principal).
          stages: ADMISSION_REVIEW_CHAIN as unknown as Prisma.InputJsonValue,
          currentStage: 0,
          approvals: [] as unknown as Prisma.InputJsonValue,
          status: "NEW",
        },
        select: { id: true, status: true },
      }),
    );
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
      createdAt: r.createdAt,
    };
  }
}
