// =============================================================================
// CbtService — computer-based mock exams with absolute server authority
// =============================================================================
// The Games/Integrity posture applied to testing: a question's answerIndex is
// NEVER serialized to a student until their sitting is submitted; the window
// and duration are validated server-side from the sitting's own startedAt;
// question sampling/shuffling happens here. Students see only their OWN
// sitting (404-not-403); staff (cbt.manage) see everything in their tenant.
// Mutations audited. Auto-marks are numbers staff review — no automated
// consequence attaches to them (Golden Rule #8).

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import { randomUUID } from "node:crypto";
import type {
  CbtBankDto,
  CbtExamDto,
  CbtExamResultsDto,
  CbtSittingViewDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** Grace after the duration elapses before a late save/submit is refused. */
const SUBMIT_GRACE_MS = 30_000;

interface QuestionInput {
  prompt: string;
  choices: string[];
  answerIndex: number;
}

@Injectable()
export class CbtService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- banks & questions (staff) ---------------------------------------------

  async listBanks(p: Principal): Promise<CbtBankDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const banks = await tx.cbtQuestionBank.findMany({ orderBy: { createdAt: "desc" } });
      const counts = await tx.cbtQuestion.groupBy({ by: ["bankId"], _count: { id: true } });
      const countOf = new Map(counts.map((c) => [c.bankId, c._count.id]));
      return banks.map((b) => ({
        id: b.id,
        name: b.name,
        subject: b.subject,
        questionCount: countOf.get(b.id) ?? 0,
        createdAt: b.createdAt,
      }));
    });
  }

  async createBank(p: Principal, input: { name: string; subject?: string | null }): Promise<CbtBankDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const bank = await tx.cbtQuestionBank.create({
        data: { schoolId: p.schoolId, name: input.name.trim(), subject: input.subject?.trim() || null, createdById: p.userId },
      });
      await this.log(tx, p, "cbt.bank.create", bank.id, { name: bank.name });
      return { id: bank.id, name: bank.name, subject: bank.subject, questionCount: 0, createdAt: bank.createdAt };
    });
  }

  /** Bulk-add questions (typed rows — the CSV parse happens client-side). */
  async addQuestions(p: Principal, bankId: string, questions: QuestionInput[]): Promise<{ added: number }> {
    for (const q of questions) {
      if (q.choices.length < 2 || q.choices.length > 6) throw new BadRequestException("Each question needs 2–6 choices");
      if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= q.choices.length) {
        throw new BadRequestException("answerIndex must point at one of the choices");
      }
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const bank = await tx.cbtQuestionBank.findFirst({ where: { id: bankId } });
      if (!bank) throw new NotFoundException("Bank not found");
      await tx.cbtQuestion.createMany({
        data: questions.map((q) => ({
          schoolId: p.schoolId,
          bankId,
          prompt: q.prompt.trim(),
          choices: q.choices as unknown as Prisma.InputJsonValue,
          answerIndex: q.answerIndex,
        })),
      });
      await this.log(tx, p, "cbt.bank.questions_add", bankId, { added: questions.length });
      return { added: questions.length };
    });
  }

  // --- exams (staff) -----------------------------------------------------------

  async createExam(
    p: Principal,
    input: {
      bankId: string;
      title: string;
      classId?: string | null;
      questionCount: number;
      durationMinutes: number;
      startAt: string;
      endAt: string;
    },
  ): Promise<CbtExamDto> {
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (!(startAt < endAt)) throw new BadRequestException("endAt must be after startAt");
    if (input.durationMinutes < 5 || input.durationMinutes > 300) {
      throw new BadRequestException("durationMinutes must be 5–300");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const bank = await tx.cbtQuestionBank.findFirst({ where: { id: input.bankId } });
      if (!bank) throw new NotFoundException("Bank not found");
      const available = await tx.cbtQuestion.count({ where: { bankId: input.bankId } });
      if (available === 0) throw new ConflictException("The bank has no questions yet");
      const exam = await tx.cbtExam.create({
        data: {
          schoolId: p.schoolId,
          bankId: input.bankId,
          title: input.title.trim(),
          classId: input.classId ?? null,
          questionCount: Math.min(Math.max(1, input.questionCount), available),
          durationMinutes: input.durationMinutes,
          startAt,
          endAt,
          createdById: p.userId,
        },
      });
      await this.log(tx, p, "cbt.exam.create", exam.id, { title: exam.title, bankId: input.bankId });
      return this.toExamDto(tx, exam, p);
    });
  }

  async setExamStatus(p: Principal, examId: string, status: "PUBLISHED" | "CLOSED"): Promise<CbtExamDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const exam = await tx.cbtExam.findFirst({ where: { id: examId } });
      if (!exam) throw new NotFoundException("Exam not found");
      await tx.cbtExam.update({ where: { id: examId }, data: { status } });
      await this.log(tx, p, "cbt.exam.status", examId, { status });
      return this.toExamDto(tx, { ...exam, status }, p);
    });
  }

  /** Staff see every exam; students see PUBLISHED exams open to them. */
  async listExams(p: Principal, staff: boolean): Promise<CbtExamDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      let exams;
      if (staff) {
        exams = await tx.cbtExam.findMany({ orderBy: { startAt: "desc" }, take: 100 });
      } else {
        // Student view: published, current-or-upcoming, and class-open to them.
        const myClasses = await tx.enrollment.findMany({
          where: { studentId: p.userId },
          select: { classId: true },
        });
        const classIds = myClasses.map((e) => e.classId);
        exams = await tx.cbtExam.findMany({
          where: {
            status: "PUBLISHED",
            endAt: { gte: new Date() },
            OR: [{ classId: null }, { classId: { in: classIds } }],
          },
          orderBy: { startAt: "asc" },
          take: 50,
        });
      }
      const out: CbtExamDto[] = [];
      for (const e of exams) out.push(await this.toExamDto(tx, e, p));
      return out;
    });
  }

  // --- sittings (students) ------------------------------------------------------

  /** Start (or resume) the caller's sitting. Samples the questions server-side. */
  async startSitting(p: Principal, examId: string): Promise<CbtSittingViewDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const exam = await tx.cbtExam.findFirst({ where: { id: examId } });
      if (!exam || exam.status !== "PUBLISHED") throw new NotFoundException("Exam not found");
      const now = new Date();
      if (now < exam.startAt) throw new ConflictException("The exam has not opened yet");
      if (now > exam.endAt) throw new ConflictException("The exam window has closed");
      if (exam.classId) {
        const enrolled = await tx.enrollment.findFirst({ where: { classId: exam.classId, studentId: p.userId } });
        if (!enrolled) throw new NotFoundException("Exam not found"); // 404-not-403
      }

      let sitting = await tx.cbtSitting.findFirst({ where: { examId, studentId: p.userId } });
      if (!sitting) {
        // Server-side sample: shuffle the bank, take N — the order is FIXED for
        // the sitting so refreshes can't fish for new questions.
        const pool = await tx.cbtQuestion.findMany({ where: { bankId: exam.bankId }, select: { id: true } });
        const ids = pool.map((q) => q.id);
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j]!, ids[i]!];
        }
        const sampled = exam.shuffle ? ids.slice(0, exam.questionCount) : ids.sort().slice(0, exam.questionCount);
        sitting = await tx.cbtSitting.create({
          data: {
            id: randomUUID(),
            schoolId: p.schoolId,
            examId,
            studentId: p.userId,
            questionIds: sampled as unknown as Prisma.InputJsonValue,
          },
        });
        await this.log(tx, p, "cbt.sitting.start", sitting.id, { examId });
      }
      return this.sittingView(tx, exam, sitting, p);
    });
  }

  /** Save one answer (upsert). Refused after time is up — the clock is server law. */
  async answer(p: Principal, sittingId: string, questionId: string, choiceIndex: number): Promise<{ ok: true }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.cbtSitting.findFirst({ where: { id: sittingId, studentId: p.userId } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      if (sitting.status !== "IN_PROGRESS") throw new ConflictException("This sitting is finished");
      const exam = await tx.cbtExam.findFirst({ where: { id: sitting.examId } });
      if (!exam) throw new NotFoundException("Sitting not found");
      if (this.timeUp(sitting.startedAt, exam, new Date())) {
        await this.finalize(tx, p, sitting.id, "EXPIRED");
        throw new ConflictException("Time is up — the sitting has been submitted automatically");
      }
      const order = sitting.questionIds as unknown as string[];
      if (!order.includes(questionId)) throw new BadRequestException("Not one of your questions");
      const answers = { ...((sitting.answers as Record<string, number> | null) ?? {}), [questionId]: choiceIndex };
      await tx.cbtSitting.update({
        where: { id: sitting.id },
        data: { answers: answers as unknown as Prisma.InputJsonValue },
      });
      return { ok: true as const };
    });
  }

  /** Submit and auto-mark. Idempotent: a finished sitting returns its view. */
  async submit(p: Principal, sittingId: string): Promise<CbtSittingViewDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.cbtSitting.findFirst({ where: { id: sittingId, studentId: p.userId } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      const exam = await tx.cbtExam.findFirst({ where: { id: sitting.examId } });
      if (!exam) throw new NotFoundException("Sitting not found");
      if (sitting.status === "IN_PROGRESS") {
        const expired = this.timeUp(sitting.startedAt, exam, new Date());
        await this.finalize(tx, p, sitting.id, expired ? "EXPIRED" : "SUBMITTED");
      }
      const fresh = await tx.cbtSitting.findFirst({ where: { id: sitting.id } });
      return this.sittingView(tx, exam, fresh!, p);
    });
  }

  /** The caller's own sitting view (resume screen / results). */
  async getSitting(p: Principal, sittingId: string): Promise<CbtSittingViewDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.cbtSitting.findFirst({ where: { id: sittingId, studentId: p.userId } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      const exam = await tx.cbtExam.findFirst({ where: { id: sitting.examId } });
      if (!exam) throw new NotFoundException("Sitting not found");
      // Auto-expire on read so an abandoned tab still finalizes.
      if (sitting.status === "IN_PROGRESS" && this.timeUp(sitting.startedAt, exam, new Date())) {
        await this.finalize(tx, p, sitting.id, "EXPIRED");
        const fresh = await tx.cbtSitting.findFirst({ where: { id: sitting.id } });
        return this.sittingView(tx, exam, fresh!, p);
      }
      return this.sittingView(tx, exam, sitting, p);
    });
  }

  /** Staff: per-exam results table (names + scores; no answer sheets here). */
  async examResults(p: Principal, examId: string): Promise<CbtExamResultsDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const exam = await tx.cbtExam.findFirst({ where: { id: examId } });
      if (!exam) throw new NotFoundException("Exam not found");
      const sittings = await tx.cbtSitting.findMany({ where: { examId }, orderBy: { score: "desc" } });
      const students = await tx.user.findMany({
        where: { id: { in: sittings.map((s) => s.studentId) } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(students.map((s) => [s.id, s.name]));
      await this.log(tx, p, "cbt.exam.results_read", examId, { sittings: sittings.length });
      return {
        exam: await this.toExamDto(tx, exam, p),
        rows: sittings.map((s) => ({
          sittingId: s.id,
          studentId: s.studentId,
          studentName: nameOf.get(s.studentId) ?? "Student",
          status: s.status,
          score: s.score,
          total: s.total,
          startedAt: s.startedAt,
          submittedAt: s.submittedAt,
        })),
      };
    });
  }

  // --- internals ---------------------------------------------------------------

  private timeUp(startedAt: Date, exam: { durationMinutes: number; endAt: Date }, now: Date): boolean {
    const deadline = Math.min(
      startedAt.getTime() + exam.durationMinutes * 60_000 + SUBMIT_GRACE_MS,
      exam.endAt.getTime() + SUBMIT_GRACE_MS,
    );
    return now.getTime() > deadline;
  }

  /** Score + close a sitting (optimistic: only the IN_PROGRESS row transitions). */
  private async finalize(tx: TenantTx, p: Principal, sittingId: string, status: "SUBMITTED" | "EXPIRED"): Promise<void> {
    const sitting = await tx.cbtSitting.findFirst({ where: { id: sittingId } });
    if (!sitting || sitting.status !== "IN_PROGRESS") return;
    const order = sitting.questionIds as unknown as string[];
    const answers = (sitting.answers as Record<string, number> | null) ?? {};
    const questions = await tx.cbtQuestion.findMany({
      where: { id: { in: order } },
      select: { id: true, answerIndex: true },
    });
    const correctOf = new Map(questions.map((q) => [q.id, q.answerIndex]));
    const score = order.reduce((n, qid) => (answers[qid] != null && answers[qid] === correctOf.get(qid) ? n + 1 : n), 0);
    const updated = await tx.cbtSitting.updateMany({
      where: { id: sittingId, status: "IN_PROGRESS" },
      data: { status, submittedAt: new Date(), score, total: order.length },
    });
    if (updated.count > 0) {
      await this.log(tx, p, "cbt.sitting.finalize", sittingId, { status, score, total: order.length });
    }
  }

  /** The student-safe view: answerIndex appears ONLY after the sitting closes. */
  private async sittingView(
    tx: TenantTx,
    exam: { id: string; title: string; durationMinutes: number; endAt: Date },
    sitting: {
      id: string;
      status: string;
      startedAt: Date;
      submittedAt: Date | null;
      questionIds: unknown;
      answers: unknown;
      score: number | null;
      total: number | null;
    },
    p: Principal,
  ): Promise<CbtSittingViewDto> {
    const order = sitting.questionIds as string[];
    const rows = await tx.cbtQuestion.findMany({
      where: { id: { in: order } },
      select: { id: true, prompt: true, choices: true, answerIndex: true },
    });
    const byId = new Map(rows.map((q) => [q.id, q]));
    const finished = sitting.status !== "IN_PROGRESS";
    const deadline = Math.min(sitting.startedAt.getTime() + exam.durationMinutes * 60_000, exam.endAt.getTime());
    void p;
    return {
      sittingId: sitting.id,
      examId: exam.id,
      examTitle: exam.title,
      status: sitting.status,
      startedAt: sitting.startedAt,
      deadline: new Date(deadline),
      submittedAt: sitting.submittedAt,
      score: finished ? sitting.score : null,
      total: finished ? sitting.total : null,
      answers: (sitting.answers as Record<string, number> | null) ?? {},
      questions: order
        .map((qid) => byId.get(qid))
        .filter((q): q is NonNullable<typeof q> => Boolean(q))
        .map((q) => ({
          id: q.id,
          prompt: q.prompt,
          choices: q.choices as unknown as string[],
          // SERVER AUTHORITY: the key is withheld until the sitting is closed.
          answerIndex: finished ? q.answerIndex : null,
        })),
    };
  }

  private async toExamDto(
    tx: TenantTx,
    exam: {
      id: string;
      title: string;
      bankId: string;
      classId: string | null;
      questionCount: number;
      durationMinutes: number;
      startAt: Date;
      endAt: Date;
      status: string;
    },
    p: Principal,
  ): Promise<CbtExamDto> {
    const [sittings, mine] = await Promise.all([
      tx.cbtSitting.count({ where: { examId: exam.id } }),
      tx.cbtSitting.findFirst({ where: { examId: exam.id, studentId: p.userId }, select: { id: true, status: true } }),
    ]);
    return {
      id: exam.id,
      title: exam.title,
      bankId: exam.bankId,
      classId: exam.classId,
      questionCount: exam.questionCount,
      durationMinutes: exam.durationMinutes,
      startAt: exam.startAt,
      endAt: exam.endAt,
      status: exam.status,
      sittings,
      mySittingId: mine?.id ?? null,
      mySittingStatus: mine?.status ?? null,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "cbt", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
