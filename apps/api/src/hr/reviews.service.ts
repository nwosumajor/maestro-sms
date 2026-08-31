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
import { isStaffRoles } from "@sms/types";
import type { AppraisalDto, DisciplinaryCaseDto, DisciplinaryEntryDto } from "@sms/types";
import { assertStillHere } from "../common/still-here";
import { NotificationService } from "../notifications/notification.service";
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
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- appraisals ------------------------------------------------------------

  /**
   * The HR module is for STAFF, and it never said so.
   *
   * `openCase` and `createAppraisal` both checked only that the target EXISTS in
   * the tenant, so a disciplinary case or an appraisal could be opened against a
   * PUPIL — measured live, 201 for both.
   *
   * That is not a tidy-up. A child's disciplinary record belongs in the student
   * discipline module, which has a confidentiality chain built for it: the
   * accused gets a 404, their guardian a 403, and the reporter is protected. The
   * HR file has none of that and a different readership (`hr.disciplinary.manage`
   * — principal, school_admin, hr_manager). And it is INVISIBLE to the pupil's
   * NDPR export bundle, whose gate derives student-keyed models: this table is
   * keyed on `userId`, so a child's record here would appear in no section and in
   * no exclusion — the exact defect that bundle's manifest exists to prevent.
   *
   * Found by asserting the property in that gate ("staff-only: a pupil can hold
   * no row here") and then checking whether anything made it true.
   */
  private async assertStaff(
    tx: TenantTx,
    userId: string,
    what: string,
    // THE WAY OUT DEPENDS ON WHICH PERSON IS WRONG. The trailing sentence was
    // fixed text about the student discipline area — right when a pupil is the
    // SUBJECT of a record, and wrong when one is named as a REVIEWER, where it
    // sends the reader somewhere that has nothing to do with what they were
    // doing. A refusal must not point at the wrong remedy.
    wayOut = "A pupil's record belongs in the student discipline area.",
  ): Promise<{ name: string }> {
    const user = (await tx.user.findFirst({
      where: { id: userId },
      select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } },
    })) as { id: string; name: string; roles: Array<{ role: { name: string } }> } | null;
    if (!user) throw new NotFoundException("User not found");
    if (!isStaffRoles(user.roles.map((r) => r.role.name))) {
      throw new BadRequestException(
        `${user.name} is not a member of staff, so no ${what} can be opened here. ${wayOut}`,
      );
    }
    return { name: user.name };
  }

  async createAppraisal(p: Principal, userId: string, input: AppraisalInput): Promise<AppraisalDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const user = await this.assertStaff(tx, userId, "appraisal");
      // WHO IS REVIEWING. It defaulted to the creator and the supplied value was
      // taken on trust — not staff, not still here, not even checked to exist.
      // Latent only because no screen sent one; the API has always accepted it,
      // and a screen is being given to it now.
      //
      // The same two questions every other duty in this product asks, and for
      // the same reason: an appraisal names somebody accountable for a
      // colleague's review, and `staff-handover` reads `reviewerId` to tell a
      // school what a LEAVER still owes it.
      const reviewerId = input.reviewerId ?? p.userId;
      if (reviewerId !== p.userId) {
        await this.assertStaff(
          tx,
          reviewerId,
          "appraisal reviewer",
          "Choose a colleague, or leave the reviewer blank to review it yourself.",
        );
        await assertStillHere(tx, reviewerId, "appraisal reviewer");
      }
      const a = await tx.appraisal.create({
        data: {
          schoolId: p.schoolId,
          userId,
          reviewerId,
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

  /**
   * The reviewer finishes the appraisal and it becomes the appraisee's to
   * acknowledge.
   *
   * TELL THEM. The chain is DRAFT → SUBMITTED by the reviewer → ACKNOWLEDGED by
   * the APPRAISEE, so its final step is an action only that person can take —
   * and nothing in this service told them there was anything to take. The
   * appraisal simply appeared on a page they had no reason to open that week.
   * A chain whose last step waits on somebody who was never asked does not
   * complete; it stalls, and the stall looks like the staff member ignoring it.
   *
   * The notification carries NO rating and no comments. It says an appraisal is
   * ready and where to read it — the record itself is behind the usual scoping,
   * and a score is not something to put in an inbox line.
   */
  async submitAppraisal(p: Principal, id: string): Promise<AppraisalDto> {
    const dto = await this.transitionAppraisal(p, id, "SUBMITTED", "DRAFT", "hr.appraisal.submit");
    // After the transition commits: a notification failure must not undo a
    // submitted appraisal.
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: dto.userId,
        type: "GENERIC",
        title: "Your appraisal is ready to read",
        body: "Your reviewer has completed your performance appraisal. Open Leave & HR to read it and acknowledge it.",
        data: { appraisalId: dto.id },
      });
    } catch {
      /* non-fatal — the appraisal is the durable record, the notice is not */
    }
    return dto;
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
      const user = await this.assertStaff(tx, userId, "disciplinary case");
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
