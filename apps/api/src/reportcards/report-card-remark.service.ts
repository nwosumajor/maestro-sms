// =============================================================================
// ReportCardRemarkService — class-teacher + head narrative remarks per term
// =============================================================================
// Nigerian report cards carry a class-teacher's remark and a head's remark.
// This stores them per (student, term), upserted, and feeds them into the
// generated PDF. Two authorization tiers, both audited:
//   - CLASS-TEACHER remark: staff-wide, OR a teacher/supervisor of a class the
//     student is enrolled in (grade.write). Stamped with the writer's id.
//   - HEAD remark: staff-wide only (principal/school_admin/super_admin).
// Reads are scoped exactly like the report card itself (staff / self / guardian
// / teacher-of-class), 404-not-403 for anyone else.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ReportCardRemarkDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);

type RemarkRow = {
  studentId: string;
  termId: string;
  classTeacherRemark: string | null;
  classTeacherId: string | null;
  headRemark: string | null;
  headId: string | null;
  updatedAt: Date;
};

@Injectable()
export class ReportCardRemarkService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private toDto(studentId: string, termId: string, r: RemarkRow | null): ReportCardRemarkDto {
    return {
      studentId,
      termId,
      classTeacherRemark: r?.classTeacherRemark ?? null,
      headRemark: r?.headRemark ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
  }

  /** Read scope: staff-wide / self / guardian / teacher-of-the-student's-class. */
  private async assertCanRead(tx: TenantTx, p: Principal, studentId: string): Promise<void> {
    if (p.roles.some((r) => STAFF_WIDE.has(r))) return;
    if (p.userId === studentId) return;
    if (await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } })) return;
    if (await this.teachesStudent(tx, p, studentId)) return;
    throw new NotFoundException("Not found");
  }

  private async teachesStudent(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    const taught = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    const supervised = await tx.class.findMany({ where: { supervisorId: p.userId }, select: { id: true } });
    const classIds = [
      ...taught.map((t: { classId: string }) => t.classId),
      ...supervised.map((c: { id: string }) => c.id),
    ];
    if (classIds.length === 0) return false;
    const enr = await tx.enrollment.findFirst({ where: { studentId, classId: { in: classIds } }, select: { id: true } });
    return !!enr;
  }

  async get(p: Principal, studentId: string, termId: string): Promise<ReportCardRemarkDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      await this.assertCanRead(tx, p, studentId);
      const row = await tx.reportCardRemark.findFirst({ where: { studentId, termId } });
      return this.toDto(studentId, termId, row as RemarkRow | null);
    });
  }

  /** Set the class-teacher remark. Staff-wide OR a teacher/supervisor of the
   *  student's class. */
  async setClassTeacherRemark(
    p: Principal,
    studentId: string,
    termId: string,
    remark: string,
  ): Promise<ReportCardRemarkDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
      if (!staffWide && !(await this.teachesStudent(tx, p, studentId))) {
        throw new ForbiddenException("Only the student's class teacher or a school administrator may set this remark");
      }
      await this.assertTermExists(tx, termId);
      const row = await tx.reportCardRemark.upsert({
        where: { studentId_termId: { studentId, termId } },
        create: { schoolId: p.schoolId, studentId, termId, classTeacherRemark: remark, classTeacherId: p.userId },
        update: { classTeacherRemark: remark, classTeacherId: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "reportcard.remark.class_teacher", entity: "user", entityId: studentId, schoolId: p.schoolId, metadata: { termId } },
        tx,
      );
      return this.toDto(studentId, termId, row as RemarkRow);
    });
  }

  /** Set the head remark. Staff-wide only (principal / school_admin). */
  async setHeadRemark(p: Principal, studentId: string, termId: string, remark: string): Promise<ReportCardRemarkDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (!p.roles.some((r) => STAFF_WIDE.has(r))) {
        throw new ForbiddenException("Only the principal or a school administrator may set the head's remark");
      }
      await this.assertTermExists(tx, termId);
      const row = await tx.reportCardRemark.upsert({
        where: { studentId_termId: { studentId, termId } },
        create: { schoolId: p.schoolId, studentId, termId, headRemark: remark, headId: p.userId },
        update: { headRemark: remark, headId: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "reportcard.remark.head", entity: "user", entityId: studentId, schoolId: p.schoolId, metadata: { termId } },
        tx,
      );
      return this.toDto(studentId, termId, row as RemarkRow);
    });
  }

  private async assertTermExists(tx: TenantTx, termId: string): Promise<void> {
    const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true } });
    if (!term) throw new NotFoundException("Term not found");
  }

  /** In-tx read for the PDF generator (no extra scope check — the generator
   *  already asserted access to the student). */
  async remarksForPdf(tx: TenantTx, studentId: string, termId: string): Promise<{ classTeacher: string | null; head: string | null }> {
    const row = await tx.reportCardRemark.findFirst({ where: { studentId, termId } });
    return { classTeacher: row?.classTeacherRemark ?? null, head: row?.headRemark ?? null };
  }
}
