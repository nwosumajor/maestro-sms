// =============================================================================
// PromotionService — end-of-session class promotion with maker-checker
// =============================================================================
// An initiator STAGES a promotion batch (status PENDING): which class's students
// move into which target class — NOTHING moves yet. school_admin (a DIFFERENT
// person — separation of duties) approves, which in ONE tenant transaction marks
// each source enrollment PROMOTED and creates a new ACTIVE enrollment in the
// target class (idempotent), or GRADUATED when the source has no next class.
// Tenant-scoped (RLS), every action audited. Mirrors the SIS-import maker-checker.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@sms/db";
import type { PromotionBatchDto, PromotionDecisionDto, PromotionOutcome } from "@sms/types";
import { PROMOTION_OUTCOMES } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

interface BatchRow {
  id: string;
  sourceClassId: string;
  targetClassId: string | null;
  studentIds: unknown;
  decisions: unknown;
  status: string;
  initiatedById: string;
  reviewedById: string | null;
  reviewNote: string | null;
  createdAt: Date;
}

/** Read the per-student decisions off a batch row (empty for legacy batches). */
const decisionsOf = (b: BatchRow): PromotionDecisionDto[] =>
  Array.isArray(b.decisions) ? (b.decisions as unknown as PromotionDecisionDto[]) : [];

@Injectable()
export class PromotionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Stage a PENDING promotion batch (moves nothing). Target defaults to the
   *  source class's nextClassId; students default to all ACTIVE enrollments.
   *  `decisions` optionally overrides individual students to RETAIN (stay in the
   *  present class) or DEMOTE (into an explicitly chosen lower class); anyone not
   *  named is PROMOTEd. Every outcome is the initiator's own decision — the
   *  service never derives one from grades (Golden Rule #8). */
  async stage(
    p: Principal,
    input: {
      sourceClassId: string;
      targetClassId?: string | null;
      studentIds?: string[];
      decisions?: PromotionDecisionDto[];
    },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const source = await tx.class.findFirst({ where: { id: input.sourceClassId } });
      if (!source) throw new NotFoundException("Source class not found");

      const targetClassId =
        input.targetClassId === undefined ? source.nextClassId : input.targetClassId;
      if (targetClassId) {
        if (targetClassId === input.sourceClassId) {
          throw new BadRequestException("A class cannot promote into itself");
        }
        const target = await tx.class.findFirst({ where: { id: targetClassId }, select: { id: true } });
        if (!target) throw new NotFoundException("Target class not found");
      }

      let studentIds = input.studentIds;
      if (!studentIds || studentIds.length === 0) {
        const enrolled = await tx.enrollment.findMany({
          where: { classId: input.sourceClassId, status: "ACTIVE" },
          select: { studentId: true },
        });
        studentIds = enrolled.map((e) => e.studentId);
      }
      if (studentIds.length === 0) throw new BadRequestException("No students to promote");

      const decisions = await this.normaliseDecisions(tx, input, studentIds, targetClassId ?? null);

      const batch = await tx.promotionBatch.create({
        data: {
          schoolId: p.schoolId,
          sourceClassId: input.sourceClassId,
          targetClassId: targetClassId ?? null,
          studentIds: studentIds as unknown as Prisma.InputJsonValue,
          decisions: decisions as unknown as Prisma.InputJsonValue,
          status: "PENDING",
          initiatedById: p.userId,
        },
      });
      const tally = this.tally(decisions);
      await this.log(tx, p, "lms.promotion.stage", batch.id, {
        sourceClassId: input.sourceClassId,
        targetClassId: targetClassId ?? null,
        count: studentIds.length,
        ...tally,
      });
      return this.toDto(tx, batch as unknown as BatchRow);
    });
  }

  /** Validate the initiator's per-student overrides and fill PROMOTE for the
   *  rest, so the stored batch is an explicit, complete record of the decision. */
  private async normaliseDecisions(
    tx: TenantTx,
    input: { sourceClassId: string; decisions?: PromotionDecisionDto[] },
    studentIds: string[],
    targetClassId: string | null,
  ): Promise<PromotionDecisionDto[]> {
    const inBatch = new Set(studentIds);
    const byStudent = new Map<string, PromotionDecisionDto>();

    for (const d of input.decisions ?? []) {
      if (!inBatch.has(d.studentId)) {
        throw new BadRequestException("A decision names a student who is not in this class batch");
      }
      if (byStudent.has(d.studentId)) {
        throw new BadRequestException("Duplicate decision for the same student");
      }
      if (d.outcome === PROMOTION_OUTCOMES.DEMOTE) {
        if (!d.targetClassId) {
          throw new BadRequestException("A demotion must name the class the student moves down into");
        }
        if (d.targetClassId === input.sourceClassId) {
          throw new BadRequestException("Demoting into the present class is a retention — choose RETAIN");
        }
        if (targetClassId && d.targetClassId === targetClassId) {
          throw new BadRequestException("Demoting into the promotion target class is a promotion — choose PROMOTE");
        }
      }
      byStudent.set(d.studentId, {
        studentId: d.studentId,
        outcome: d.outcome,
        targetClassId: d.outcome === PROMOTION_OUTCOMES.DEMOTE ? d.targetClassId : null,
        note: d.note?.trim() ? d.note.trim() : null,
      });
    }

    // Every demotion target must exist in THIS tenant (RLS scopes the lookup).
    const demoteTargets = [
      ...new Set(
        [...byStudent.values()]
          .filter((d) => d.outcome === PROMOTION_OUTCOMES.DEMOTE)
          .map((d) => d.targetClassId as string),
      ),
    ];
    if (demoteTargets.length > 0) {
      const found = await tx.class.findMany({ where: { id: { in: demoteTargets } }, select: { id: true } });
      if (found.length !== demoteTargets.length) throw new NotFoundException("Demotion target class not found");
    }

    // Anyone without an explicit override is promoted.
    return studentIds.map(
      (studentId) =>
        byStudent.get(studentId) ?? {
          studentId,
          outcome: PROMOTION_OUTCOMES.PROMOTE,
          targetClassId: null,
          note: null,
        },
    );
  }

  private tally(decisions: PromotionDecisionDto[]) {
    const count = (o: PromotionOutcome) => decisions.filter((d) => d.outcome === o).length;
    return {
      promoteCount: count(PROMOTION_OUTCOMES.PROMOTE),
      retainCount: count(PROMOTION_OUTCOMES.RETAIN),
      demoteCount: count(PROMOTION_OUTCOMES.DEMOTE),
    };
  }

  async list(p: Principal): Promise<PromotionBatchDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.promotionBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      return Promise.all((rows as unknown as BatchRow[]).map((b) => this.toDto(tx, b)));
    });
  }

  async get(p: Principal, id: string): Promise<PromotionBatchDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = (await tx.promotionBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!b) throw new NotFoundException("Promotion batch not found");
      return this.toDto(tx, b);
    });
  }

  /** Approve (school_admin, a DIFFERENT person): move the enrollments in-tx. */
  async approve(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.promotionBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Promotion batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      // SECURITY: separation of duties — the approver cannot be the initiator.
      if (batch.initiatedById === p.userId) {
        throw new ForbiddenException("A different person must approve the promotion you initiated");
      }

      const studentIds = (batch.studentIds as string[] | null) ?? [];
      const stored = decisionsOf(batch);
      // Legacy batches (no decisions) mean "promote everyone" — unchanged behaviour.
      const decisions: PromotionDecisionDto[] =
        stored.length > 0
          ? stored
          : studentIds.map((studentId) => ({
              studentId,
              outcome: PROMOTION_OUTCOMES.PROMOTE,
              targetClassId: null,
              note: null,
            }));

      const graduating = !batch.targetClassId;
      const promoting = decisions.filter((d) => d.outcome === PROMOTION_OUTCOMES.PROMOTE).map((d) => d.studentId);
      const retaining = decisions.filter((d) => d.outcome === PROMOTION_OUTCOMES.RETAIN).map((d) => d.studentId);
      const demotions = decisions.filter((d) => d.outcome === PROMOTION_OUTCOMES.DEMOTE);

      // Group the demotions by destination so each lands in one pair of statements.
      const byTarget = new Map<string, string[]>();
      for (const d of demotions) {
        const t = d.targetClassId as string;
        byTarget.set(t, [...(byTarget.get(t) ?? []), d.studentId]);
      }

      let moved = 0;
      let graduated = 0;

      // --- PROMOTE (or GRADUATE when the source has no next class) -------------
      if (promoting.length > 0) {
        await tx.enrollment.updateMany({
          where: { classId: batch.sourceClassId, studentId: { in: promoting } },
          data: { status: graduating ? "GRADUATED" : "PROMOTED" },
        });
        if (graduating) {
          graduated = promoting.length;
        } else {
          moved += await this.enrollInto(tx, p.schoolId, batch.targetClassId as string, promoting);
        }
      }

      // --- DEMOTE: leave the source class, enter the chosen lower class --------
      for (const [targetClassId, ids] of byTarget) {
        await tx.enrollment.updateMany({
          where: { classId: batch.sourceClassId, studentId: { in: ids } },
          data: { status: "DEMOTED" },
        });
        moved += await this.enrollInto(tx, p.schoolId, targetClassId, ids);
      }

      // --- RETAIN: deliberately NOTHING. The student's ACTIVE enrollment in the
      // present class stands, so they repeat it. The decision is recorded on the
      // batch and in the audit log rather than by moving any row.

      const updated = await tx.promotionBatch.update({
        where: { id },
        data: { status: "APPROVED", reviewedById: p.userId },
      });
      await this.log(tx, p, "lms.promotion.approve", id, {
        moved,
        graduated,
        retained: retaining.length,
        demoted: demotions.length,
      });
      return this.toDto(tx, updated as unknown as BatchRow);
    });
  }

  async reject(p: Principal, id: string, note?: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const batch = (await tx.promotionBatch.findFirst({ where: { id } })) as BatchRow | null;
      if (!batch) throw new NotFoundException("Promotion batch not found");
      if (batch.status !== "PENDING") throw new ConflictException("Batch already decided");
      const updated = await tx.promotionBatch.update({
        where: { id },
        data: { status: "REJECTED", reviewedById: p.userId, reviewNote: note ?? null },
      });
      await this.log(tx, p, "lms.promotion.reject", id, {});
      return this.toDto(tx, updated as unknown as BatchRow);
    });
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Enroll students into a destination class: skips anyone already there
   * (idempotent re-approval) and refuses — rolling the whole batch back — if the
   * destination would overflow its capacity. Shared by promotion and demotion so
   * a demoted student can never silently overfill a lower class.
   */
  private async enrollInto(
    tx: TenantTx,
    schoolId: string,
    classId: string,
    studentIds: string[],
  ): Promise<number> {
    const already = new Set(
      (
        await tx.enrollment.findMany({
          where: { classId, studentId: { in: studentIds } },
          select: { studentId: true },
        })
      ).map((e: { studentId: string }) => e.studentId),
    );
    const incoming = studentIds.filter((s) => !already.has(s));

    const cls = await tx.class.findFirst({ where: { id: classId }, select: { capacity: true, name: true } });
    if (cls?.capacity != null) {
      const activeNow = await tx.enrollment.count({ where: { classId, status: "ACTIVE" } });
      if (activeNow + incoming.length > cls.capacity) {
        throw new ConflictException(`${cls.name} is at capacity (${cls.capacity})`);
      }
    }
    if (incoming.length > 0) {
      await tx.enrollment.createMany({
        data: incoming.map((studentId) => ({ schoolId, classId, studentId, status: "ACTIVE" })),
        skipDuplicates: true,
      });
    }
    // Re-approval of an already-applied batch must not double-count.
    return studentIds.length;
  }

  private async toDto(tx: TenantTx, b: BatchRow): Promise<PromotionBatchDto> {
    const raw = decisionsOf(b);
    const ids = [
      ...new Set([
        b.sourceClassId,
        ...(b.targetClassId ? [b.targetClassId] : []),
        // Demotion destinations, so the reviewer sees a name not a uuid.
        ...raw.map((d) => d.targetClassId).filter((x): x is string => !!x),
      ]),
    ];
    const classes = await tx.class.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(classes.map((c) => [c.id, c.name]));
    const decisions: PromotionDecisionDto[] = raw.map((d) => ({
      ...d,
      targetClassName: d.targetClassId ? (nameOf.get(d.targetClassId) ?? null) : null,
    }));
    const studentCount = ((b.studentIds as string[] | null) ?? []).length;
    // Legacy batches carry no decisions but DO promote everyone — report that
    // rather than three misleading zeros.
    const counts =
      decisions.length > 0
        ? this.tally(decisions)
        : { promoteCount: studentCount, retainCount: 0, demoteCount: 0 };
    return {
      id: b.id,
      sourceClassId: b.sourceClassId,
      sourceClassName: nameOf.get(b.sourceClassId) ?? "",
      targetClassId: b.targetClassId,
      targetClassName: b.targetClassId ? (nameOf.get(b.targetClassId) ?? null) : null,
      studentCount,
      status: b.status,
      initiatedById: b.initiatedById,
      reviewedById: b.reviewedById,
      reviewNote: b.reviewNote,
      createdAt: b.createdAt,
      decisions,
      ...counts,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "promotion_batch", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
