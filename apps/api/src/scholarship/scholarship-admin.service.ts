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
  /** Per-position prizes (kobo) — 2nd/3rd fall back to awardMinor when null. */
  award2Minor?: number | null;
  award3Minor?: number | null;
  examDurationMin?: number;
  /** Owner-authored CBT question set. */
  examQuestions?: Array<{ text: string; options: string[]; answerIndex: number }> | null;
  /** Append a single CBT question (the console adds them one at a time). */
  appendQuestion?: { text: string; options: string[]; answerIndex: number };
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
        award2Minor: input.award2Minor ?? null,
        award3Minor: input.award3Minor ?? null,
        examDurationMin: input.examDurationMin ?? 30,
        examQuestions: (input.examQuestions ?? null) as Prisma.InputJsonValue,
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
    if (input.award2Minor !== undefined) data.award2Minor = input.award2Minor ?? null;
    if (input.award3Minor !== undefined) data.award3Minor = input.award3Minor ?? null;
    if (input.examDurationMin !== undefined) data.examDurationMin = input.examDurationMin;
    if (input.examQuestions !== undefined) data.examQuestions = (input.examQuestions ?? null) as Prisma.InputJsonValue;
    // Append one question to the existing set (the console adds them one by one;
    // answers are server-only so the client can't resend the whole array).
    if (input.appendQuestion) {
      const current = Array.isArray(existing.examQuestions) ? (existing.examQuestions as unknown[]) : [];
      data.examQuestions = [...current, input.appendQuestion] as unknown as Prisma.InputJsonValue;
    }
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
      db.scholarshipProgram.findMany({
        where: { id: { in: programIds } },
        select: { id: true, title: true, awardMinor: true, examMode: true, examAt: true },
      }),
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
      examMode: prog.get(r.programId)?.examMode ?? null,
      examAt: prog.get(r.programId)?.examAt ?? null,
      examScorePct: r.examScorePct,
      awardPosition: r.awardPosition,
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
    body: { action: "REVIEW" | "SHORTLIST" | "QUALIFY" | "REJECT" | "AWARD"; note?: string; awardMinor?: number; position?: number },
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
      const program = await db.scholarshipProgram.findFirst({
        where: { id: app.programId },
        select: { title: true, awardMinor: true, award2Minor: true, award3Minor: true, awardKind: true },
      });
      // Position 1|2|3 → the matching prize (2nd/3rd fall back to 1st when unset);
      // an explicit awardMinor override still wins. Each position granted ONCE.
      const position = body.position && [1, 2, 3].includes(body.position) ? body.position : 1;
      const positionAmount =
        position === 3 ? program?.award3Minor ?? program?.awardMinor ?? 0
        : position === 2 ? program?.award2Minor ?? program?.awardMinor ?? 0
        : program?.awardMinor ?? 0;
      const awardMinor = body.awardMinor ?? positionAmount;
      if (awardMinor <= 0) throw new BadRequestException("award amount must be positive");
      // Best Three: at most SCHOLARSHIP_MAX_AWARDS awards, and each POSITION once.
      const awardedRows = await db.scholarshipApplication.findMany({
        where: { programId: app.programId, status: "AWARDED" },
        select: { awardPosition: true },
      });
      if (awardedRows.length >= SCHOLARSHIP_MAX_AWARDS) {
        throw new BadRequestException(`This scholarship already has its best ${SCHOLARSHIP_MAX_AWARDS} awardees`);
      }
      if (awardedRows.some((a) => a.awardPosition === position)) {
        throw new BadRequestException(`The ${position === 1 ? "1st" : position === 2 ? "2nd" : "3rd"} position has already been awarded`);
      }
      nextStatus = "AWARDED";
      // Disburse a fees credit into the student's OWN school (privileged; the
      // Payment carries the school's id so it's correctly tenant-owned).
      if ((program?.awardKind ?? "FEES_CREDIT") === "FEES_CREDIT") {
        disbursement = await this.disburseFeesCredit(db, app.schoolId, app.studentId, awardMinor, app.id, p.userId);
      }
      await db.scholarshipApplication.update({
        where: { id },
        data: { status: nextStatus as never, awardMinor, awardPosition: position, reviewedById: p.userId, reviewNote: body.note ?? null, disbursementPaymentId: disbursement?.paymentId ?? null },
      });
      await this.auditOwn(p, "scholarship.award", id, { targetSchoolId: app.schoolId, studentId: app.studentId, awardMinor, position, disbursed: disbursement?.amountMinor ?? 0 });
      const posLabel = position === 1 ? "1st" : position === 2 ? "2nd" : "3rd";
      await this.notifyFamily(
        p,
        app.schoolId,
        app.studentId,
        `🎉 Scholarship AWARDED (${posLabel} position) — “${program?.title ?? "Scholarship"}”`,
        `Congratulations on finishing in ${posLabel} position! The award has been credited against the student's school fees.`,
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

  /** Announce the qualification exam AND materialize the real sitting surface:
   *   ONLINE_CBT → one CbtQuestionBank + CbtExam per candidate's school, seeded
   *                from the program's owner-authored question set, scoped to
   *                that school and marked `scholarshipProgramId` so ONLY that
   *                school's QUALIFIED candidates can sit it (the CBT module gates
   *                on it). PUBLISHED, window = examAt … examAt+durationMin.
   *   GAMES      → one cross-school Ultimate arena competition tagged
   *                `scholarshipProgramId`; each candidate's school is enrolled
   *                and their guardian's chain-consent is written as an
   *                UltimateConsent, so entry passes the arena's own two-tier gate
   *                without needing the school's general crossSchoolEnabled flag.
   *   PHYSICAL   → notify only (no on-platform surface).
   *  Idempotent: re-announcing reuses existing exams/competition (no duplicates).
   *  Every candidate + guardians are notified with the mode, date and how to sit. */
  async announceExam(p: Principal, programId: string): Promise<{ notified: number; cbtExams: number; arena: boolean }> {
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
    if (candidates.length === 0) throw new BadRequestException("No qualified candidates to announce to yet");

    const questions = Array.isArray(program.examQuestions)
      ? (program.examQuestions as unknown as Array<{ text: string; options: string[]; answerIndex: number }>)
      : [];
    const examEnd = new Date(program.examAt.getTime() + (program.examDurationMin ?? 30) * 60 * 1000);
    const bySchool = new Map<string, string[]>();
    for (const c of candidates) {
      const arr = bySchool.get(c.schoolId) ?? [];
      arr.push(c.studentId);
      bySchool.set(c.schoolId, arr);
    }

    let cbtExams = 0;
    let arena = false;

    // --- ONLINE_CBT: a per-school exam seeded from the program's questions -----
    if (program.examMode === "ONLINE_CBT") {
      if (questions.length === 0) {
        throw new BadRequestException("Add CBT questions to the program before announcing an online CBT exam");
      }
      for (const [schoolId] of bySchool) {
        // Idempotent per (program, school): reuse an existing materialized exam.
        const existing = await db.cbtExam.findFirst({ where: { schoolId, scholarshipProgramId: programId } });
        if (existing) {
          await db.cbtExam.update({
            where: { id: existing.id },
            data: { startAt: program.examAt, endAt: examEnd, durationMinutes: program.examDurationMin ?? 30, status: "PUBLISHED" },
          });
          cbtExams += 1;
          continue;
        }
        const bank = await db.cbtQuestionBank.create({
          data: { schoolId, name: `Scholarship: ${program.title}`, subject: String(program.category).replaceAll("_", " "), createdById: p.userId },
        });
        await db.cbtQuestion.createMany({
          data: questions.map((q) => ({
            schoolId,
            bankId: bank.id,
            prompt: q.text,
            choices: q.options as unknown as Prisma.InputJsonValue,
            answerIndex: q.answerIndex,
          })),
        });
        await db.cbtExam.create({
          data: {
            schoolId,
            bankId: bank.id,
            title: `Scholarship exam — ${program.title}`,
            questionCount: questions.length,
            durationMinutes: program.examDurationMin ?? 30,
            startAt: program.examAt,
            endAt: examEnd,
            status: "PUBLISHED",
            shuffle: true,
            scholarshipProgramId: programId,
            createdById: p.userId,
          },
        });
        cbtExams += 1;
      }
    }

    // --- GAMES: one arena competition + per-candidate enrollment/consent -------
    if (program.examMode === "GAMES") {
      let comp = await db.ultimateCompetition.findFirst({ where: { scholarshipProgramId: programId } });
      if (!comp) {
        comp = await db.ultimateCompetition.create({
          data: {
            name: `Scholarship: ${program.title}`,
            difficultyLength: 5,
            status: "ACTIVE",
            startAt: program.examAt,
            endAt: examEnd,
            scholarshipProgramId: programId,
            createdById: p.userId,
          },
        });
      }
      for (const [schoolId, studentIds] of bySchool) {
        // Tier-1: enroll the school into THIS competition (idempotent).
        const enrolled = await db.ultimateEnrollment.findFirst({ where: { competitionId: comp.id, schoolId } });
        if (!enrolled) {
          await db.ultimateEnrollment.create({ data: { competitionId: comp.id, schoolId, enrolledById: p.userId } });
        }
        // Tier-2: the chain's guardian approval already consented — write it as
        // the arena's per-student consent so entry passes without re-asking.
        for (const studentId of studentIds) {
          const c = await db.ultimateConsent.findFirst({ where: { schoolId, studentId } });
          if (!c) {
            await db.ultimateConsent.create({ data: { schoolId, studentId, granted: true, grantedById: p.userId } });
          } else if (!c.granted) {
            await db.ultimateConsent.update({ where: { id: c.id }, data: { granted: true, grantedById: p.userId } });
          }
        }
      }
      arena = true;
    }

    // --- notify every candidate + guardians -----------------------------------
    const when = program.examAt.toISOString().slice(0, 16).replace("T", " at ");
    const howTo =
      program.examMode === "ONLINE_CBT" ? "Sit it under CBT Exams in the app on the exam date."
      : program.examMode === "GAMES" ? "Enter it from Games → Ultimate on the exam date."
      : "Attend at the venue below.";
    const modeLabel =
      program.examMode === "ONLINE_CBT" ? "an online CBT mock exam" : program.examMode === "GAMES" ? "the games arena" : "a physical scheduled exam";
    let notified = 0;
    for (const c of candidates) {
      await this.notifyFamily(
        p,
        c.schoolId,
        c.studentId,
        `Scholarship exam scheduled — “${program.title}”`,
        `Category: ${String(program.category).replaceAll("_", " ").toLowerCase()}. The exam holds via ${modeLabel} on ${when} (UTC)${program.examVenue ? ` — ${program.examVenue}` : ""}. ${howTo} Good luck!`,
      );
      notified += 1;
    }
    await this.auditOwn(p, "scholarship.exam.announce", programId, { candidates: candidates.length, examMode: program.examMode, cbtExams, arena });
    return { notified, cbtExams, arena };
  }

  /** Harvest exam results back onto the QUALIFIED applications as a score SIGNAL
   *  (Golden Rule #8 — informs the award, isn't the award). ONLINE_CBT reads the
   *  student's submitted CbtSitting score %; GAMES ranks arena finishers by
   *  (fewest guesses → fastest own-start elapsed) into a relative %. Returns how
   *  many candidates now carry a score. */
  async collectExamResults(p: Principal, programId: string): Promise<{ updated: number }> {
    const db = this.client();
    const program = await db.scholarshipProgram.findFirst({ where: { id: programId } });
    if (!program) throw new NotFoundException("Program not found");
    const candidates = await db.scholarshipApplication.findMany({
      where: { programId, status: "QUALIFIED" },
      select: { id: true, schoolId: true, studentId: true },
    });
    let updated = 0;

    if (program.examMode === "ONLINE_CBT") {
      for (const c of candidates) {
        const exam = await db.cbtExam.findFirst({ where: { schoolId: c.schoolId, scholarshipProgramId: programId }, select: { id: true } });
        if (!exam) continue;
        const sitting = await db.cbtSitting.findFirst({
          where: { examId: exam.id, studentId: c.studentId, status: "SUBMITTED" },
          select: { score: true, total: true },
        });
        if (!sitting || sitting.total == null || sitting.total === 0 || sitting.score == null) continue;
        const pct = Math.round((sitting.score / sitting.total) * 10000) / 100;
        await db.scholarshipApplication.update({ where: { id: c.id }, data: { examScorePct: pct } });
        updated += 1;
      }
    } else if (program.examMode === "GAMES") {
      const comp = await db.ultimateCompetition.findFirst({ where: { scholarshipProgramId: programId }, select: { id: true } });
      if (comp) {
        // Rank finishers: fewest guesses, then fastest own-start elapsed.
        const finishers = await db.ultimateParticipant.findMany({
          where: { competitionId: comp.id, status: "FINISHED" },
          select: { id: true, guessCount: true, elapsedMs: true },
        });
        finishers.sort((a, b) => (a.guessCount - b.guessCount) || ((a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity)));
        // participantId → userId via the tenant-scoped entry link (per school).
        const n = finishers.length;
        for (let rank = 0; rank < n; rank++) {
          const part = finishers[rank];
          const link = await db.ultimateEntryLink.findFirst({ where: { participantId: part.id }, select: { userId: true } });
          if (!link) continue;
          const cand = candidates.find((c) => c.studentId === link.userId);
          if (!cand) continue;
          // Relative standing %: 1st = 100, last = ~ (1/n)·100.
          const pct = Math.round(((n - rank) / n) * 10000) / 100;
          await db.scholarshipApplication.update({ where: { id: cand.id }, data: { examScorePct: pct } });
          updated += 1;
        }
      }
    } else {
      throw new BadRequestException("Automatic result collection applies to online CBT and games exams only");
    }
    await this.auditOwn(p, "scholarship.exam.collect", programId, { examMode: program.examMode, updated });
    return { updated };
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
      db.scholarshipProgram.findFirst({
        where: { id: r.programId },
        select: { title: true, awardMinor: true, examMode: true, examAt: true },
      }),
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
      examMode: program?.examMode ?? null, examAt: program?.examAt ?? null,
      examScorePct: r.examScorePct, awardPosition: r.awardPosition,
      awardMinor: r.awardMinor, reviewNote: r.reviewNote,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }];
  }

  private programDto(r: {
    id: string; title: string; description: string | null; budgetMinor: number; awardMinor: number;
    award2Minor: number | null; award3Minor: number | null;
    awardKind: string; selectionBasis: string; eligibility: unknown; opensAt: Date; closesAt: Date; status: string;
    category: string; examMode: string | null; examAt: Date | null; examVenue: string | null;
    examDurationMin: number; examQuestions: unknown; createdAt: Date;
  }): ScholarshipProgramDto {
    return {
      id: r.id, title: r.title, description: r.description, budgetMinor: r.budgetMinor, awardMinor: r.awardMinor,
      award2Minor: r.award2Minor, award3Minor: r.award3Minor,
      awardKind: r.awardKind, selectionBasis: r.selectionBasis, eligibility: r.eligibility ?? null,
      opensAt: r.opensAt, closesAt: r.closesAt, status: r.status,
      category: r.category, examMode: r.examMode, examAt: r.examAt, examVenue: r.examVenue,
      examDurationMin: r.examDurationMin,
      examQuestionCount: Array.isArray(r.examQuestions) ? r.examQuestions.length : 0,
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
