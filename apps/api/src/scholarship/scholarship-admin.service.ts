// =============================================================================
// ScholarshipAdminService — platform owner (super_admin), CROSS-TENANT
// =============================================================================
// The platform owner defines/funds programs (GLOBAL table) and reviews + awards
// applications across ALL schools. Program writes and the cross-tenant review
// queue use the PRIVILEGED client (bypasses RLS by design, like operator
// provisioning / retention). An AWARD disburses through the FEES ledger: a
// PaymentKind.SCHOLARSHIP payment posted against the student's open invoice in
// their own school — integer kobo, audited, never hard-deleted. Every action is
// audit-logged in the operator's own tenant.
// SECURITY (Golden Rule #8): the platform owner DECIDES; the snapshotted signals
// only inform the decision.
// =============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@sms/db";
import { SCHOLARSHIP_MAX_AWARDS, type ScholarshipApplicationDto, type ScholarshipProgramDto } from "@sms/types";
import { NotificationService } from "../notifications/notification.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { Inject } from "@nestjs/common";

interface ProgramInput {
  title: string;
  description?: string | null;
  budgetMinor: number;
  awardMinor: number;
  awardKind?: string;
  selectionBasis?: string;
  eligibility?: unknown;
  opensAt: string;
  closesAt: string;
  status?: string;
  /** GENERAL_SCIENCE | ART | COMMUNITY_DEVELOPMENT | MATHEMATICS | SPECIAL. */
  category?: string;
  /** Qualification exam: ONLINE_CBT | GAMES | PHYSICAL (+ date + venue text). */
  examMode?: string | null;
  examAt?: string | null;
  examVenue?: string | null;
}

@Injectable()
export class ScholarshipAdminService {
  private readonly logger = new Logger("Scholarship");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  private client(): PrismaClient {
    const c = this.privileged.client;
    if (!c) throw new ServiceUnavailableException("Scholarship administration is not configured");
    return c;
  }

  // --- programs (global) -----------------------------------------------------
  async listPrograms(): Promise<ScholarshipProgramDto[]> {
    const rows = await this.client().scholarshipProgram.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.programDto(r));
  }

  async createProgram(p: Principal, input: ProgramInput): Promise<ScholarshipProgramDto> {
    const opensAt = new Date(input.opensAt);
    const closesAt = new Date(input.closesAt);
    if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) throw new BadRequestException("invalid dates");
    if (closesAt <= opensAt) throw new BadRequestException("closesAt must be after opensAt");
    if (input.awardMinor <= 0) throw new BadRequestException("awardMinor must be positive");
    const row = await this.client().scholarshipProgram.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        budgetMinor: input.budgetMinor,
        awardMinor: input.awardMinor,
        awardKind: (input.awardKind ?? "FEES_CREDIT") as never,
        selectionBasis: (input.selectionBasis ?? "BOTH") as never,
        eligibility: (input.eligibility ?? null) as Prisma.InputJsonValue,
        opensAt,
        closesAt,
        status: (input.status ?? "DRAFT") as never,
        category: (input.category ?? "SPECIAL") as never,
        examMode: (input.examMode ?? null) as never,
        examAt: input.examAt ? new Date(input.examAt) : null,
        examVenue: input.examVenue ?? null,
        createdById: p.userId,
      },
    });
    await this.auditOwn(p, "scholarship.program.create", row.id, { title: input.title });
    return this.programDto(row);
  }

  async updateProgram(p: Principal, id: string, input: Partial<ProgramInput>): Promise<ScholarshipProgramDto> {
    const existing = await this.client().scholarshipProgram.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException("Program not found");
    const data: Prisma.ScholarshipProgramUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.budgetMinor !== undefined) data.budgetMinor = input.budgetMinor;
    if (input.awardMinor !== undefined) data.awardMinor = input.awardMinor;
    if (input.awardKind !== undefined) data.awardKind = input.awardKind as never;
    if (input.selectionBasis !== undefined) data.selectionBasis = input.selectionBasis as never;
    if (input.eligibility !== undefined) data.eligibility = (input.eligibility ?? null) as Prisma.InputJsonValue;
    if (input.opensAt !== undefined) data.opensAt = new Date(input.opensAt);
    if (input.closesAt !== undefined) data.closesAt = new Date(input.closesAt);
    if (input.status !== undefined) data.status = input.status as never;
    if (input.category !== undefined) data.category = input.category as never;
    if (input.examMode !== undefined) data.examMode = (input.examMode ?? null) as never;
    if (input.examAt !== undefined) data.examAt = input.examAt ? new Date(input.examAt) : null;
    if (input.examVenue !== undefined) data.examVenue = input.examVenue ?? null;
    const row = await this.client().scholarshipProgram.update({ where: { id }, data });
    await this.auditOwn(p, "scholarship.program.update", id, { status: input.status });
    return this.programDto(row);
  }

  // --- review queue (cross-tenant) -------------------------------------------
  async listApplications(filter: { status?: string; programId?: string }): Promise<ScholarshipApplicationDto[]> {
    const db = this.client();
    const where: Prisma.ScholarshipApplicationWhereInput = {};
    // Never show DRAFTs to the platform (they aren't submitted yet).
    where.status = filter.status ? (filter.status as never) : { not: "DRAFT" };
    if (filter.programId) where.programId = filter.programId;
    const rows = await db.scholarshipApplication.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 });
    if (rows.length === 0) return [];
    const programIds = [...new Set(rows.map((r) => r.programId))];
    const userIds = [...new Set(rows.flatMap((r) => [r.studentId, r.applicantId]))];
    const schoolIds = [...new Set(rows.map((r) => r.schoolId))];
    const [programs, users, schools] = await Promise.all([
      db.scholarshipProgram.findMany({ where: { id: { in: programIds } }, select: { id: true, title: true, awardMinor: true } }),
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      db.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } }),
    ]);
    const prog = new Map(programs.map((pr) => [pr.id, pr]));
    const name = new Map(users.map((u) => [u.id, u.name]));
    const school = new Map(schools.map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      id: r.id,
      programId: r.programId,
      programTitle: prog.get(r.programId)?.title ?? "Scholarship",
      awardMinorOffered: prog.get(r.programId)?.awardMinor ?? 0,
      schoolId: r.schoolId,
      schoolName: school.get(r.schoolId) ?? null,
      studentId: r.studentId,
      studentName: name.get(r.studentId) ?? "Student",
      applicantId: r.applicantId,
      applicantName: name.get(r.applicantId) ?? "Applicant",
      applicantRole: r.applicantRole,
      answers: r.answers ?? null,
      signals: (r.signals as ScholarshipApplicationDto["signals"]) ?? null,
      status: r.status,
      consentById: r.consentById,
      consentAt: r.consentAt,
      supervisorById: r.supervisorById,
      supervisorAt: r.supervisorAt,
      supervisorNote: r.supervisorNote,
      parentNote: r.parentNote,
      principalById: r.principalById,
      principalAt: r.principalAt,
      principalNote: r.principalNote,
      rejectedStage: r.rejectedStage,
      awardMinor: r.awardMinor,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  // --- decisions -------------------------------------------------------------
  /** Advance an application: REVIEW (→UNDER_REVIEW), SHORTLIST, QUALIFY (the
   *  student becomes a candidate for the scholarship exam), REJECT, or AWARD.
   *  AWARD disburses a FEES_CREDIT via the Fees ledger and is CAPPED at the
   *  Best Three per program. Student + guardians are notified of every outcome. */
  async decide(
    p: Principal,
    id: string,
    body: { action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT" | "AWARD"; note?: string; awardMinor?: number },
  ): Promise<ScholarshipApplicationDto> {
    const db = this.client();
    const app = await db.scholarshipApplication.findFirst({ where: { id } });
    if (!app) throw new NotFoundException("Application not found");
    const inChain = ["DRAFT", "PENDING_SUPERVISOR", "PENDING_PARENT", "PENDING_PRINCIPAL"].includes(app.status);
    if (inChain) throw new BadRequestException("This application has not completed its school approval chain");
    if (app.status === "AWARDED" || app.status === "REJECTED") {
      throw new BadRequestException("This application has already been finalised");
    }

    let disbursement: { paymentId: string; amountMinor: number } | null = null;
    let nextStatus: string = app.status;
    if (body.action === "REVIEW") nextStatus = "UNDER_REVIEW";
    else if (body.action === "SHORTLIST") nextStatus = "SHORTLISTED";
    else if (body.action === "QUALIFY") nextStatus = "QUALIFIED";
    else if (body.action === "REJECT") nextStatus = "REJECTED";
    else if (body.action === "AWARD") {
      const program = await db.scholarshipProgram.findFirst({ where: { id: app.programId }, select: { title: true, awardMinor: true, awardKind: true } });
      const awardMinor = body.awardMinor ?? program?.awardMinor ?? 0;
      if (awardMinor <= 0) throw new BadRequestException("award amount must be positive");
      // Best Three: a program grants at most SCHOLARSHIP_MAX_AWARDS awards.
      const awarded = await db.scholarshipApplication.count({ where: { programId: app.programId, status: "AWARDED" } });
      if (awarded >= SCHOLARSHIP_MAX_AWARDS) {
        throw new BadRequestException(`This scholarship already has its best ${SCHOLARSHIP_MAX_AWARDS} awardees`);
      }
      nextStatus = "AWARDED";
      // Disburse a fees credit into the student's OWN school (privileged; the
      // Payment carries the school's id so it's correctly tenant-owned).
      if ((program?.awardKind ?? "FEES_CREDIT") === "FEES_CREDIT") {
        disbursement = await this.disburseFeesCredit(db, app.schoolId, app.studentId, awardMinor, app.id, p.userId);
      }
      await db.scholarshipApplication.update({
        where: { id },
        data: { status: nextStatus as never, awardMinor, reviewedById: p.userId, reviewNote: body.note ?? null, disbursementPaymentId: disbursement?.paymentId ?? null },
      });
      await this.auditOwn(p, "scholarship.award", id, { targetSchoolId: app.schoolId, studentId: app.studentId, awardMinor, disbursed: disbursement?.amountMinor ?? 0 });
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        `🎉 Scholarship AWARDED — “${program?.title ?? "Scholarship"}”`,
        "Congratulations! The award has been credited against the student's school fees.",
      );
      const [row] = await this.listApplicationById(db, id);
      return row;
    }

    await db.scholarshipApplication.update({
      where: { id },
      data: {
        status: nextStatus as never,
        reviewedById: p.userId,
        reviewNote: body.note ?? app.reviewNote,
        ...(body.action === "REJECT" ? { rejectedStage: "PLATFORM" } : {}),
      },
    });
    await this.auditOwn(p, `scholarship.${body.action.toLowerCase()}`, id, { targetSchoolId: app.schoolId, status: nextStatus });
    if (body.action === "QUALIFY") {
      const program = await db.scholarshipProgram.findFirst({ where: { id: app.programId }, select: { title: true } });
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        `Qualified for the scholarship exam — “${program?.title ?? "Scholarship"}”`,
        "The student is now a qualified candidate. The exam category, mode and date will be announced on the platform.",
      );
    } else if (body.action === "REJECT") {
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        "Scholarship application outcome",
        `The application was not successful at the sponsor's review.${body.note ? ` Note: ${body.note}` : ""}`,
      );
    }
    const [row] = await this.listApplicationById(db, id);
    return row;
  }

  /** Announce the qualification exam for a program: notifies EVERY QUALIFIED
   *  candidate (student + guardians, in their own school's tenant) of the
   *  category, exam mode (online CBT / games / physical), date and venue.
   *  Requires the exam details to be set on the program first. */
  async announceExam(p: Principal, programId: string): Promise<{ notified: number }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({ where: { id: programId } });
    if (!program) throw new NotFoundException("Program not found");
    if (!program.examMode || !program.examAt) {
      throw new BadRequestException("Set the exam mode and date on the program before announcing");
    }
    const candidates = await db.scholarshipApplication.findMany({
      where: { programId, status: "QUALIFIED" },
      select: { schoolId: true, studentId: true },
    });
    const when = program.examAt.toISOString().slice(0, 16).replace("T", " at ");
    const modeLabel =
      program.examMode === "ONLINE_CBT" ? "an online CBT mock exam" : program.examMode === "GAMES" ? "the games arena" : "a physical scheduled exam";
    let notified = 0;
    for (const c of candidates) {
      await this.notifyFamily(
        p,
        c.schoolId,
        c.studentId,
        `Scholarship exam scheduled — “${program.title}”`,
        `Category: ${String(program.category).replaceAll("_", " ").toLowerCase()}. The exam holds via ${modeLabel} on ${when} (UTC)${program.examVenue ? ` — ${program.examVenue}` : ""}. Good luck!`,
      );
      notified += 1;
    }
    await this.auditOwn(p, "scholarship.exam.announce", programId, { candidates: candidates.length, examMode: program.examMode, examAt: program.examAt });
    return { notified };
  }

  /** Notify the student AND their guardians inside THEIR OWN school's tenant
   *  (the operator writes the notification rows under that school's GUC — RLS
   *  intact; recipients read them via their normal self-scoped inbox). */
  private async notifyFamily(p: Principal, schoolId: string, studentId: string, title: string, body: string): Promise<void> {
    const ctx = { schoolId, userId: p.userId };
    try {
      await this.notifications.enqueue(ctx, { recipientId: studentId, type: "SCHOLARSHIP", title, body });
      const guardians = await this.db.runAsTenant(ctx, (tx) =>
        tx.parentChild.findMany({ where: { studentId }, select: { parentId: true } }),
      );
      for (const g of guardians as Array<{ parentId: string }>) {
        await this.notifications.enqueue(ctx, { recipientId: g.parentId, type: "SCHOLARSHIP", title, body }).catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`scholarship family notify failed (non-fatal): ${String(err)}`);
    }
  }

  /** Post a SCHOLARSHIP payment against the student's most recent open invoice
   *  (capped at the outstanding balance so it never over-credits). Updates the
   *  invoice status. Returns null if there's no open invoice to credit. */
  private async disburseFeesCredit(
    db: PrismaClient,
    schoolId: string,
    studentId: string,
    awardMinor: number,
    applicationId: string,
    actorId: string,
  ): Promise<{ paymentId: string; amountMinor: number } | null> {
    const invoice = await db.invoice.findFirst({
      where: { schoolId, studentId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
      include: { payments: true },
      orderBy: { createdAt: "desc" },
    });
    if (!invoice) return null;
    const paid = invoice.payments
      .filter((pay) => pay.status === "POSTED")
      .reduce((s, pay) => s + (pay.kind === "REFUND" ? -pay.amountMinor : pay.amountMinor), 0);
    const balance = Math.max(0, invoice.totalMinor - paid);
    if (balance <= 0) return null;
    const credit = Math.min(awardMinor, balance);
    const payment = await db.payment.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        amountMinor: credit,
        method: "OTHER",
        kind: "SCHOLARSHIP",
        status: "POSTED",
        reference: `SCHOLARSHIP:${applicationId}`,
        note: "Platform-sponsored scholarship credit",
        recordedById: actorId,
      },
    });
    const newPaid = paid + credit;
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: newPaid >= invoice.totalMinor ? "PAID" : "PARTIALLY_PAID" },
    });
    return { paymentId: payment.id, amountMinor: credit };
  }

  private async listApplicationById(db: PrismaClient, id: string): Promise<ScholarshipApplicationDto[]> {
    const rows = await db.scholarshipApplication.findMany({ where: { id } });
    if (rows.length === 0) return [];
    const r = rows[0];
    const [program, student, applicant, school] = await Promise.all([
      db.scholarshipProgram.findFirst({ where: { id: r.programId }, select: { title: true, awardMinor: true } }),
      db.user.findFirst({ where: { id: r.studentId }, select: { name: true } }),
      db.user.findFirst({ where: { id: r.applicantId }, select: { name: true } }),
      db.school.findFirst({ where: { id: r.schoolId }, select: { name: true } }),
    ]);
    return [{
      id: r.id, programId: r.programId, programTitle: program?.title ?? "Scholarship", awardMinorOffered: program?.awardMinor ?? 0,
      schoolId: r.schoolId, schoolName: school?.name ?? null, studentId: r.studentId, studentName: student?.name ?? "Student",
      applicantId: r.applicantId, applicantName: applicant?.name ?? "Applicant", applicantRole: r.applicantRole,
      answers: r.answers ?? null, signals: (r.signals as ScholarshipApplicationDto["signals"]) ?? null, status: r.status,
      consentById: r.consentById, consentAt: r.consentAt,
      supervisorById: r.supervisorById, supervisorAt: r.supervisorAt, supervisorNote: r.supervisorNote,
      parentNote: r.parentNote, principalById: r.principalById, principalAt: r.principalAt, principalNote: r.principalNote,
      rejectedStage: r.rejectedStage,
      awardMinor: r.awardMinor, reviewNote: r.reviewNote,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }];
  }

  private programDto(r: {
    id: string; title: string; description: string | null; budgetMinor: number; awardMinor: number;
    awardKind: string; selectionBasis: string; eligibility: unknown; opensAt: Date; closesAt: Date; status: string;
    category: string; examMode: string | null; examAt: Date | null; examVenue: string | null; createdAt: Date;
  }): ScholarshipProgramDto {
    return {
      id: r.id, title: r.title, description: r.description, budgetMinor: r.budgetMinor, awardMinor: r.awardMinor,
      awardKind: r.awardKind, selectionBasis: r.selectionBasis, eligibility: r.eligibility ?? null,
      opensAt: r.opensAt, closesAt: r.closesAt, status: r.status,
      category: r.category, examMode: r.examMode, examAt: r.examAt, examVenue: r.examVenue,
      createdAt: r.createdAt,
    };
  }

  /** Audit in the OPERATOR's own tenant (best-effort — the privileged write is
   *  the source of truth and is also captured by the request log). */
  private async auditOwn(p: Principal, action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db
      .runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record({ actorId: p.userId, action, entity: "scholarship", entityId, schoolId: p.schoolId, metadata }, tx),
      )
      .catch((err) => this.logger.warn(`audit '${action}' failed (non-fatal): ${String(err)}`));
  }
}
