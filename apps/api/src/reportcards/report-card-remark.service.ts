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
import { teachesStudent as teachesThisStudent } from "../common/teaches";
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

const STAFF_WIDE = new Set(["school_admin", "principal"]);

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

  /**
   * Names for the two stored author ids — the same lookup `remarksForPdf` does,
   * so a screen and the printed card can never disagree about who said what.
   * One query for both; null for an author whose account is gone, which leaves
   * the remark standing and only the name missing.
   */
  private async authorNames(
    tx: TenantTx,
    r: RemarkRow | null,
  ): Promise<{ classTeacherName: string | null; headName: string | null }> {
    const ids = [r?.classTeacherRemark ? r.classTeacherId : null, r?.headRemark ? r.headId : null].filter(
      (v): v is string => !!v,
    );
    if (ids.length === 0) return { classTeacherName: null, headName: null };
    const people = (await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    const byId = new Map(people.map((u) => [u.id, u.name]));
    return {
      classTeacherName: (r?.classTeacherRemark && r.classTeacherId ? byId.get(r.classTeacherId) : null) ?? null,
      headName: (r?.headRemark && r.headId ? byId.get(r.headId) : null) ?? null,
    };
  }

  private async toDto(tx: TenantTx, studentId: string, termId: string, r: RemarkRow | null): Promise<ReportCardRemarkDto> {
    return {
      studentId,
      termId,
      classTeacherRemark: r?.classTeacherRemark ?? null,
      headRemark: r?.headRemark ?? null,
      ...(await this.authorNames(tx, r)),
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

  /**
   * ALL THREE teaching links — see common/teaches.ts.
   *
   * This copy asked `supervisorId` OR `class_subject_teacher` and never
   * `class_teacher`, so a FORM TUTOR could not write a remark about their own
   * tutee. It was one of three different answers the platform gave to "do I
   * teach this child"; the roster gave a fourth by returning nothing at all.
   */
  private teachesStudent(tx: TenantTx, p: Principal, studentId: string): Promise<boolean> {
    return teachesThisStudent(tx, p.userId, studentId);
  }

  async get(p: Principal, studentId: string, termId: string): Promise<ReportCardRemarkDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      await this.assertCanRead(tx, p, studentId);
      const row = await tx.reportCardRemark.findFirst({ where: { studentId, termId } });
      return this.toDto(tx, studentId, termId, row as RemarkRow | null);
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
      return this.toDto(tx, studentId, termId, row as RemarkRow);
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
      return this.toDto(tx, studentId, termId, row as RemarkRow);
    });
  }

  private async assertTermExists(tx: TenantTx, termId: string): Promise<void> {
    const term = await tx.term.findFirst({ where: { id: termId }, select: { id: true } });
    if (!term) throw new NotFoundException("Term not found");
  }

  /** In-tx read for the PDF generator (no extra scope check — the generator
   *  already asserted access to the student). */
  /**
   * The two remarks AND WHO MADE THEM, for the printed card.
   *
   * `classTeacherId` / `headId` have been stamped since this table was created —
   * the model comment says so — and every reader threw them away, so a printed
   * card carried "Class teacher: ..." with no name against it. On a real report
   * card that block is the signed part: a comment about a child is somebody's
   * judgement, and an unattributed one is the school saying it collectively,
   * which is not what happened and not what a parent can reply to.
   *
   * The head's remark is staff-wide, so the person who wrote it may be the
   * principal or a school administrator. The LABEL follows the writer rather
   * than being fixed, because printing "Principal's comments" over a school
   * administrator's words is a small lie on a document families keep.
   */
  async remarksForPdf(
    tx: TenantTx,
    studentId: string,
    termId: string,
  ): Promise<{
    classTeacher: { text: string; byName: string | null } | null;
    head: { text: string; byName: string | null; label: string } | null;
  }> {
    const row = (await tx.reportCardRemark.findFirst({ where: { studentId, termId } })) as RemarkRow | null;
    if (!row) return { classTeacher: null, head: null };

    const ids = [row.classTeacherRemark ? row.classTeacherId : null, row.headRemark ? row.headId : null].filter(
      (v): v is string => !!v,
    );
    const people = ids.length
      ? ((await tx.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } },
        })) as Array<{ id: string; name: string; roles: Array<{ role: { name: string } }> }>)
      : [];
    const byId = new Map(people.map((u) => [u.id, u]));

    const headAuthor = row.headId ? byId.get(row.headId) : undefined;
    const headIsPrincipal = headAuthor?.roles.some((r) => r.role.name === "principal") ?? false;

    return {
      classTeacher: row.classTeacherRemark
        ? {
            text: row.classTeacherRemark,
            byName: (row.classTeacherId ? byId.get(row.classTeacherId)?.name : null) ?? null,
          }
        : null,
      head: row.headRemark
        ? {
            text: row.headRemark,
            byName: headAuthor?.name ?? null,
            // Named for whoever actually signed it. With no recorded author the
            // generic label is the honest one.
            label: headAuthor ? (headIsPrincipal ? "Principal's comments" : "Head teacher's comments") : "Head teacher's comments",
          }
        : null,
    };
  }
}
