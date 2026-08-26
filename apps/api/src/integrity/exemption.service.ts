// =============================================================================
// ExemptionService — accessibility accommodations for integrity monitoring
// =============================================================================
// The one part of the integrity module that had no write path. The
// StudentIntegrityExemption table existed, RLS covered it, IntegrityService
// already READ an active exemption and correctly turned monitoring off — and
// nothing could create one. Meanwhile /help told students "if you use assistive
// technology, ask your teacher for an exemption", told teachers to "grant
// exemptions for students using assistive technology", and the answer field
// repeated it to the pupil. The mechanism did not exist.
//
// That is not a cosmetic gap. Paste-blocking and focus tracking are friction
// aimed at a keyboard; a pupil using a screen reader, speech-to-text or a
// switch device trips them by using their own tools. Without a way to record an
// accommodation the monitoring applies to them anyway, which is what CLAUDE.md
// means by "it becomes discriminatory".
//
// SCOPING. `integrity.exemption.write` is held by teacher, school_admin and
// principal. A teacher may only exempt a pupil they actually teach — resolved
// through classTeacher x enrollment, 404-not-403 so one teacher's roster is not
// enumerable by another. school_admin/principal act school-wide, matching
// IntegrityReportService's SCHOOL_WIDE_ROLES exactly (and, per the standing
// posture, super_admin is NOT in that set).
//
// AUDIT. Golden Rule #5: this is a record ABOUT a minor's disability
// accommodation, so every grant, revoke AND list is audit-logged. The `reason`
// is stored because a reviewer needs to know why, and is deliberately included
// in the audit metadata for grant/revoke only — not on every list read, which
// would copy the sensitive text into the log on each page view.
//
// NEVER HARD-DELETED. Revoking sets revokedAt; the row stays. The RLS policy
// omits DELETE for the app role, so this is enforced at the database too.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { IntegrityExemptionDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "./integrity.foundation";

/** Sees and manages accommodations for every pupil in the school. */
const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal"]);

/** The stored row, as this service reads it. */
type ExemptionRow = {
  id: string;
  studentId: string;
  assessmentId: string | null;
  reason: string;
  grantedById: string;
  revokedAt: Date | null;
  revokedById: string | null;
  createdAt: Date;
};

/** Name lookups shared across a whole page of exemptions. */
type ExemptionNames = { user: Map<string, string>; assessment: Map<string, string> };

@Injectable()
export class ExemptionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private wide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  /**
   * A teacher may act for a pupil enrolled in a class they teach. Throws 404 —
   * never 403 — because "you may not touch this pupil" and "this pupil is not in
   * your school" must be indistinguishable to a caller.
   */
  private async assertStudentInScope(tx: TenantTx, p: Principal, studentId: string): Promise<void> {
    // RLS already confines every row below to the caller's school.
    const student = await tx.user.findFirst({ where: { id: studentId }, select: { id: true } });
    if (!student) throw new NotFoundException("Student not found");
    if (this.wide(p)) return;

    const mine = await tx.classTeacher.findMany({
      where: { teacherId: p.userId },
      select: { classId: true },
    });
    if (mine.length === 0) throw new NotFoundException("Student not found");
    const enrolled = await tx.enrollment.findFirst({
      where: { studentId, classId: { in: mine.map((c: { classId: string }) => c.classId) } },
      select: { id: true },
    });
    if (!enrolled) throw new NotFoundException("Student not found");
  }

  /** Grant an accommodation. `assessmentId` null = every assessment. */
  async grant(
    p: Principal,
    input: { studentId: string; assessmentId?: string | null; reason: string },
  ): Promise<IntegrityExemptionDto> {
    const reason = input.reason.trim();
    if (!reason) throw new ForbiddenException("A reason is required for an accommodation");

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.assertStudentInScope(tx, p, input.studentId);

      if (input.assessmentId) {
        const assessment = await tx.assessment.findFirst({
          where: { id: input.assessmentId },
          select: { id: true },
        });
        if (!assessment) throw new NotFoundException("Assessment not found");
      }

      // An ACTIVE exemption of the same scope already covers the pupil; granting
      // a second would leave two rows to revoke and one still in force.
      const existing = await tx.studentIntegrityExemption.findFirst({
        where: {
          studentId: input.studentId,
          assessmentId: input.assessmentId ?? null,
          revokedAt: null,
        },
      });
      if (existing) return this.toDto(tx, existing.id);

      const row = await tx.studentIntegrityExemption.create({
        data: {
          schoolId: p.schoolId,
          studentId: input.studentId,
          assessmentId: input.assessmentId ?? null,
          reason,
          grantedById: p.userId,
        },
      });

      await this.audit.record(
        {
          actorId: p.userId,
          action: "integrity.exemption.grant",
          entity: "student_integrity_exemption",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: {
            studentId: input.studentId,
            assessmentId: input.assessmentId ?? null,
            scope: input.assessmentId ? "assessment" : "global",
            reason,
          },
        },
        tx,
      );
      return this.toDto(tx, row.id);
    });
  }

  /** Withdraw an accommodation. The row is kept; only revokedAt is set. */
  async revoke(p: Principal, id: string, reason?: string): Promise<IntegrityExemptionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.studentIntegrityExemption.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Exemption not found");
      await this.assertStudentInScope(tx, p, row.studentId);
      if (row.revokedAt) return this.toDto(tx, row.id);

      await tx.studentIntegrityExemption.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: p.userId },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "integrity.exemption.revoke",
          entity: "student_integrity_exemption",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { studentId: row.studentId, reason: reason?.trim() || null },
        },
        tx,
      );
      return this.toDto(tx, id);
    });
  }

  /**
   * Accommodations the caller may see. A teacher sees their own pupils'; a
   * school-wide role sees the school's. `studentId` narrows to one pupil.
   */
  async list(p: Principal, studentId?: string): Promise<IntegrityExemptionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (studentId) await this.assertStudentInScope(tx, p, studentId);

      let allowedStudentIds: string[] | null = null;
      if (!this.wide(p)) {
        const mine = await tx.classTeacher.findMany({
          where: { teacherId: p.userId },
          select: { classId: true },
        });
        const enrolled = mine.length
          ? await tx.enrollment.findMany({
              where: { classId: { in: mine.map((c: { classId: string }) => c.classId) } },
              select: { studentId: true },
            })
          : [];
        allowedStudentIds = [...new Set(enrolled.map((e: { studentId: string }) => e.studentId))];
        if (allowedStudentIds.length === 0) return [];
      }

      const rows = await tx.studentIntegrityExemption.findMany({
        where: {
          ...(studentId ? { studentId } : {}),
          ...(allowedStudentIds ? { studentId: { in: allowedStudentIds } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });

      // GR#5: reading who has a disability accommodation is a sensitive read.
      // The reason text is NOT copied into the log — the ids are enough to say
      // what was seen, and repeating the text on every page view would spread it.
      await this.audit.record(
        {
          actorId: p.userId,
          action: "integrity.exemption.read",
          entity: "student_integrity_exemption",
          entityId: studentId ?? "list",
          schoolId: p.schoolId,
          metadata: { count: rows.length, studentId: studentId ?? null },
        },
        tx,
      );

      // The rows are already in hand — mapping them by id re-read every one.
      const names = await this.namesFor(tx, rows as ExemptionRow[]);
      return (rows as ExemptionRow[]).map((r) => this.toDtoWith(r, names));
    });
  }

  /**
   * The names a page of exemptions needs, resolved ONCE.
   *
   * // GOTCHA: `list` fetched the rows and then called `toDto(tx, r.id)` for
   * each — which RE-FETCHED the row it already had, plus its users and its
   * assessment. Measured live on 500 exemptions: **501 reads of
   * `student_integrity_exemption` and 1,006 of `user` for a single request**,
   * 654 ms. 500 of those 501 were rows already in hand. This is the disability
   * accommodations screen, and it is read on every assessment page.
   */
  private async namesFor(tx: TenantTx, rows: ExemptionRow[]): Promise<ExemptionNames> {
    const userIds = new Set<string>();
    const assessmentIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.studentId);
      userIds.add(r.grantedById);
      if (r.revokedById) userIds.add(r.revokedById);
      if (r.assessmentId) assessmentIds.add(r.assessmentId);
    }
    const [users, assessments] = await Promise.all([
      userIds.size ? tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
      assessmentIds.size
        ? tx.assessment.findMany({ where: { id: { in: [...assessmentIds] } }, select: { id: true, title: true } })
        : [],
    ]);
    return {
      user: new Map(users.map((u: { id: string; name: string }) => [u.id, u.name])),
      assessment: new Map(assessments.map((a: { id: string; title: string }) => [a.id, a.title])),
    };
  }

  /** One row by id — the mutation paths, which genuinely have only an id. */
  private async toDto(tx: TenantTx, id: string): Promise<IntegrityExemptionDto> {
    const row = (await tx.studentIntegrityExemption.findFirst({ where: { id } })) as ExemptionRow | null;
    if (!row) throw new NotFoundException("Exemption not found");
    return this.toDtoWith(row, await this.namesFor(tx, [row]));
  }

  private toDtoWith(row: ExemptionRow, names: ExemptionNames): IntegrityExemptionDto {
    const name = names.user;
    const assessment = row.assessmentId ? { title: names.assessment.get(row.assessmentId) } : null;
    return {
      id: row.id,
      studentId: row.studentId,
      studentName: name.get(row.studentId) ?? "Unknown",
      assessmentId: row.assessmentId,
      assessmentTitle: assessment?.title ?? null,
      reason: row.reason,
      grantedById: row.grantedById,
      grantedByName: name.get(row.grantedById) ?? "Unknown",
      revokedAt: row.revokedAt,
      revokedByName: row.revokedById ? (name.get(row.revokedById) ?? "Unknown") : null,
      active: row.revokedAt === null,
      createdAt: row.createdAt,
    };
  }
}
