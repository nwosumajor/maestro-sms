// =============================================================================
// HrReviewsService — performance appraisals + disciplinary case files
// =============================================================================
// Appraisals: DRAFT → SUBMITTED (reviewer) → ACKNOWLEDGED (the appraisee
// acknowledges their OWN). Disciplinary: a case with an append-only entry log.
// Both are sensitive staff records; every read/mutation is audit-logged. Tenant-
// isolated (RLS); manage gated by hr.appraisal.manage / hr.disciplinary.manage,
// self-acknowledge scoped to the appraisee. No hard delete.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AppraisalDto, DisciplinaryCaseDto, DisciplinaryEntryDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

interface AppraisalInput {
  period: string;
  reviewerId?: string;
  overallRating?: number | null;
  summary?: string | null;
  goals?: string | null;
}

@Injectable()
export class HrReviewsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- appraisals ------------------------------------------------------------
  async createAppraisal(p: Principal, userId: string, input: AppraisalInput): Promise<AppraisalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const a = await tx.appraisal.create({
        data: {
          schoolId: p.schoolId,
          userId,
          reviewerId: input.reviewerId ?? p.userId,
          period: input.period,
          status: "DRAFT",
          overallRating: input.overallRating ?? null,
          summary: input.summary ?? null,
          goals: input.goals ?? null,
          createdById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.appraisal.create", entity: "appraisal", entityId: a.id, schoolId: p.schoolId, metadata: { userId } },
        tx,
      );
      return this.appraisalDto(a, user.name);
    });
  }

  async updateAppraisal(p: Principal, id: string, input: Partial<AppraisalInput>): Promise<AppraisalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.appraisal.findFirst({ where: { id } });
      if (!a) throw new NotFoundException("Appraisal not found");
      if (a.status !== "DRAFT") throw new BadRequestException("Only a DRAFT appraisal can be edited");
      const updated = await tx.appraisal.update({
        where: { id },
        data: {
          period: input.period ?? a.period,
          overallRating: input.overallRating === undefined ? a.overallRating : input.overallRating,
          summary: input.summary === undefined ? a.summary : input.summary,
          goals: input.goals === undefined ? a.goals : input.goals,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.appraisal.update", entity: "appraisal", entityId: id, schoolId: p.schoolId },
        tx,
      );
      const user = await tx.user.findFirst({ where: { id: a.userId }, select: { name: true } });
      return this.appraisalDto(updated, user?.name ?? null);
    });
  }

  async submitAppraisal(p: Principal, id: string): Promise<AppraisalDto> {
    return this.transitionAppraisal(p, id, "SUBMITTED", "DRAFT", "hr.appraisal.submit");
  }

  /** The appraisee acknowledges their OWN submitted appraisal. */
  async acknowledgeAppraisal(p: Principal, id: string): Promise<AppraisalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.appraisal.findFirst({ where: { id } });
      if (!a || a.userId !== p.userId) throw new NotFoundException("Appraisal not found"); // 404, not 403
      if (a.status !== "SUBMITTED") throw new BadRequestException("Appraisal is not awaiting acknowledgement");
      const updated = await tx.appraisal.update({
        where: { id },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date() },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.appraisal.acknowledge", entity: "appraisal", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return this.appraisalDto(updated, null);
    });
  }

  private async transitionAppraisal(p: Principal, id: string, to: string, from: string, action: string): Promise<AppraisalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const a = await tx.appraisal.findFirst({ where: { id } });
      if (!a) throw new NotFoundException("Appraisal not found");
      if (a.status !== from) throw new BadRequestException(`Cannot move from ${a.status}`);
      const updated = await tx.appraisal.update({ where: { id }, data: { status: to } });
      await this.audit.record({ actorId: p.userId, action, entity: "appraisal", entityId: id, schoolId: p.schoolId }, tx);
      const user = await tx.user.findFirst({ where: { id: a.userId }, select: { name: true } });
      return this.appraisalDto(updated, user?.name ?? null);
    });
  }

  async listAppraisals(p: Principal, userId?: string): Promise<AppraisalDto[]> {
    return this.appraisalsWhere(p, userId ? { userId } : {});
  }

  /** The appraisee's own appraisals — DRAFTs are hidden until submitted. */
  async myAppraisals(p: Principal): Promise<AppraisalDto[]> {
    return this.appraisalsWhere(p, { userId: p.userId, status: { in: ["SUBMITTED", "ACKNOWLEDGED"] } });
  }

  private async appraisalsWhere(p: Principal, where: Record<string, unknown>): Promise<AppraisalDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.appraisal.findMany({ where, orderBy: { createdAt: "desc" } });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      // Appraisals are sensitive staff records — audit the read (GR#5).
      await this.audit.record(
        { actorId: p.userId, action: "hr.appraisal.read", entity: "appraisal", entityId: p.schoolId, schoolId: p.schoolId, metadata: { count: rows.length } },
        tx,
      );
      return rows.map((a) => this.appraisalDto(a, nameById.get(a.userId) ?? null));
    });
  }

  // --- disciplinary ----------------------------------------------------------
  async openCase(
    p: Principal,
    userId: string,
    input: { title: string; category?: string | null; severity?: string },
  ): Promise<DisciplinaryCaseDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const c = await tx.disciplinaryCase.create({
        data: { schoolId: p.schoolId, userId, title: input.title, category: input.category ?? null, severity: input.severity ?? "LOW", status: "OPEN", openedById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.disciplinary.open", entity: "disciplinary_case", entityId: c.id, schoolId: p.schoolId, metadata: { userId } },
        tx,
      );
      return this.caseDto(c, user.name, []);
    });
  }

  async addEntry(p: Principal, caseId: string, note: string): Promise<DisciplinaryCaseDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const c = await tx.disciplinaryCase.findFirst({ where: { id: caseId } });
      if (!c) throw new NotFoundException("Case not found");
      await tx.disciplinaryEntry.create({ data: { schoolId: p.schoolId, caseId, note, authorId: p.userId } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.disciplinary.entry", entity: "disciplinary_case", entityId: caseId, schoolId: p.schoolId },
        tx,
      );
      return this.loadCase(tx, c.id);
    });
  }

  async setCaseStatus(p: Principal, caseId: string, status: string): Promise<DisciplinaryCaseDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const c = await tx.disciplinaryCase.findFirst({ where: { id: caseId } });
      if (!c) throw new NotFoundException("Case not found");
      await tx.disciplinaryCase.update({ where: { id: caseId }, data: { status } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.disciplinary.status", entity: "disciplinary_case", entityId: caseId, schoolId: p.schoolId, metadata: { status } },
        tx,
      );
      return this.loadCase(tx, caseId);
    });
  }

  async listCases(p: Principal, userId?: string): Promise<DisciplinaryCaseDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cases = await tx.disciplinaryCase.findMany({ where: userId ? { userId } : {}, orderBy: { createdAt: "desc" } });
      const entries = await tx.disciplinaryEntry.findMany({ where: { caseId: { in: cases.map((c) => c.id) } }, orderBy: { createdAt: "asc" } });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(cases.map((c) => c.userId))] } }, select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      const byCase = new Map<string, typeof entries>();
      for (const e of entries) (byCase.get(e.caseId) ?? byCase.set(e.caseId, []).get(e.caseId)!).push(e);
      // Disciplinary records are highly sensitive — audit the read (GR#5).
      await this.audit.record(
        { actorId: p.userId, action: "hr.disciplinary.read", entity: "disciplinary_case", entityId: p.schoolId, schoolId: p.schoolId, metadata: { count: cases.length } },
        tx,
      );
      return cases.map((c) => this.caseDto(c, nameById.get(c.userId) ?? null, byCase.get(c.id) ?? []));
    });
  }

  private async loadCase(tx: TenantTx, caseId: string): Promise<DisciplinaryCaseDto> {
    const c = await tx.disciplinaryCase.findFirst({ where: { id: caseId } });
    if (!c) throw new NotFoundException("Case not found");
    const entries = await tx.disciplinaryEntry.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
    const user = await tx.user.findFirst({ where: { id: c.userId }, select: { name: true } });
    return this.caseDto(c, user?.name ?? null, entries);
  }

  // --- decorators ------------------------------------------------------------
  private appraisalDto(
    a: { id: string; userId: string; reviewerId: string; period: string; status: string; overallRating: number | null; summary: string | null; goals: string | null; acknowledgedAt: Date | null; createdAt: Date },
    userName: string | null,
  ): AppraisalDto {
    return {
      id: a.id, userId: a.userId, userName, reviewerId: a.reviewerId, period: a.period, status: a.status,
      overallRating: a.overallRating, summary: a.summary, goals: a.goals, acknowledgedAt: a.acknowledgedAt, createdAt: a.createdAt,
    };
  }

  private caseDto(
    c: { id: string; userId: string; title: string; category: string | null; severity: string; status: string; openedById: string; createdAt: Date },
    userName: string | null,
    entries: Array<{ id: string; note: string; authorId: string; createdAt: Date }>,
  ): DisciplinaryCaseDto {
    return {
      id: c.id, userId: c.userId, userName, title: c.title, category: c.category, severity: c.severity, status: c.status,
      openedById: c.openedById, createdAt: c.createdAt,
      entries: entries.map<DisciplinaryEntryDto>((e) => ({ id: e.id, note: e.note, authorId: e.authorId, createdAt: e.createdAt })),
    };
  }
}
