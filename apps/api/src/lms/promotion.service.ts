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
import type { PromotionBatchDto } from "@sms/types";
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
  status: string;
  initiatedById: string;
  reviewedById: string | null;
  reviewNote: string | null;
  createdAt: Date;
}

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
   *  source class's nextClassId; students default to all ACTIVE enrollments. */
  async stage(
    p: Principal,
    input: { sourceClassId: string; targetClassId?: string | null; studentIds?: string[] },
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

      const batch = await tx.promotionBatch.create({
        data: {
          schoolId: p.schoolId,
          sourceClassId: input.sourceClassId,
          targetClassId: targetClassId ?? null,
          studentIds: studentIds as unknown as Prisma.InputJsonValue,
          status: "PENDING",
          initiatedById: p.userId,
        },
      });
      await this.log(tx, p, "lms.promotion.stage", batch.id, {
        sourceClassId: input.sourceClassId,
        targetClassId: targetClassId ?? null,
        count: studentIds.length,
      });
      return this.toDto(tx, batch as unknown as BatchRow);
    });
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
      const graduating = !batch.targetClassId;
      let moved = 0;
      let graduated = 0;
      for (const studentId of studentIds) {
        // Mark the source enrollment (history retained, not deleted).
        await tx.enrollment.updateMany({
          where: { classId: batch.sourceClassId, studentId },
          data: { status: graduating ? "GRADUATED" : "PROMOTED" },
        });
        if (graduating) {
          graduated++;
          continue;
        }
        // Create the target enrollment (idempotent: skip if it already exists).
        const exists = await tx.enrollment.findFirst({
          where: { classId: batch.targetClassId as string, studentId },
          select: { id: true },
        });
        if (!exists) {
          await tx.enrollment.create({
            data: { schoolId: p.schoolId, classId: batch.targetClassId as string, studentId, status: "ACTIVE" },
          });
        }
        moved++;
      }
      const updated = await tx.promotionBatch.update({
        where: { id },
        data: { status: "APPROVED", reviewedById: p.userId },
      });
      await this.log(tx, p, "lms.promotion.approve", id, { moved, graduated });
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
  private async toDto(tx: TenantTx, b: BatchRow): Promise<PromotionBatchDto> {
    const ids = [b.sourceClassId, ...(b.targetClassId ? [b.targetClassId] : [])];
    const classes = await tx.class.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(classes.map((c) => [c.id, c.name]));
    return {
      id: b.id,
      sourceClassId: b.sourceClassId,
      sourceClassName: nameOf.get(b.sourceClassId) ?? "",
      targetClassId: b.targetClassId,
      targetClassName: b.targetClassId ? (nameOf.get(b.targetClassId) ?? null) : null,
      studentCount: ((b.studentIds as string[] | null) ?? []).length,
      status: b.status,
      initiatedById: b.initiatedById,
      reviewedById: b.reviewedById,
      reviewNote: b.reviewNote,
      createdAt: b.createdAt,
    };
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "promotion_batch", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
