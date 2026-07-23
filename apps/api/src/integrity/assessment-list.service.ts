// =============================================================================
// AssessmentListService — list assessments + their submissions (scoped)
// =============================================================================
// Backs the /assessments index + a teacher's assessment→submissions drill-down.
// Relationship-scoped exactly like the rest of the module: school_admin/super_admin
// see all; a teacher sees assessments they created OR for classes they teach; a
// student sees assessments for classes they're enrolled in (+ their own submission
// status). Submissions of a minor are PII → listing them is audit-logged (GR#5).
// 404 (never 403) for an assessment the caller can't see.
// =============================================================================

import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { INTEGRITY_PERMISSIONS, LIST_CAP, type AssessmentSubmissionDto, type AssessmentSummaryDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "./integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);

@Injectable()
export class AssessmentListService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private schoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }

  async listAssessments(p: Principal): Promise<AssessmentSummaryDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      let where: Record<string, unknown> = {};
      if (!this.schoolWide(p)) {
        const taught = (await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } })).map((c) => c.classId);
        const enrolled = (await tx.enrollment.findMany({ where: { studentId: p.userId }, select: { classId: true } })).map((e) => e.classId);
        where = { OR: [{ createdById: p.userId }, { classId: { in: [...taught, ...enrolled] } }] };
      }
      // scale: school-wide staff see every assessment ever created — cap to the
      // most-recent page so a long-lived tenant can't force an unbounded scan.
      const assessments = await tx.assessment.findMany({ where, orderBy: { createdAt: "desc" }, take: LIST_CAP });
      if (assessments.length === 0) return [];
      const ids = assessments.map((a) => a.id);
      const classIds = [...new Set(assessments.map((a) => a.classId).filter((c): c is string => !!c))];
      const classes = await tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } });
      const className = new Map(classes.map((c) => [c.id, c.name]));
      const subs = await tx.submission.findMany({ where: { assessmentId: { in: ids } }, select: { assessmentId: true, studentId: true, status: true } });
      const countByAssessment = new Map<string, number>();
      const myStatus = new Map<string, string>();
      for (const s of subs) {
        countByAssessment.set(s.assessmentId, (countByAssessment.get(s.assessmentId) ?? 0) + 1);
        if (s.studentId === p.userId) myStatus.set(s.assessmentId, s.status);
      }
      return assessments.map<AssessmentSummaryDto>((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        classId: a.classId,
        className: a.classId ? (className.get(a.classId) ?? null) : null,
        createdById: a.createdById,
        mine: a.createdById === p.userId,
        integrityEnabled: a.integrityEnabled,
        fileUploadEnabled: a.fileUploadEnabled,
        submissionCount: countByAssessment.get(a.id) ?? 0,
        mySubmissionStatus: myStatus.get(a.id) ?? null,
        createdAt: a.createdAt,
      }));
    });
  }

  /** Submissions for one assessment (teacher/staff who can access it). Audited. */
  async listSubmissions(p: Principal, assessmentId: string): Promise<AssessmentSubmissionDto[]> {
    if (!p.permissions.includes(INTEGRITY_PERMISSIONS.REPORT_READ)) throw new ForbiddenException();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const assessment = await tx.assessment.findFirst({ where: { id: assessmentId } });
      if (!assessment) throw new NotFoundException("Assessment not found");
      if (!(await this.canManage(tx, p, assessment))) {
        throw new NotFoundException("Assessment not found"); // 404, not 403
      }
      const subs = await tx.submission.findMany({ where: { assessmentId }, orderBy: { submittedAt: "desc" } });
      const students = await tx.user.findMany({ where: { id: { in: subs.map((s) => s.studentId) } }, select: { id: true, name: true } });
      const nameById = new Map(students.map((u) => [u.id, u.name]));
      const signals = await tx.integritySignal.findMany({ where: { submissionId: { in: subs.map((s) => s.id) } }, select: { submissionId: true } });
      const signalCount = new Map<string, number>();
      for (const sig of signals) signalCount.set(sig.submissionId, (signalCount.get(sig.submissionId) ?? 0) + 1);
      await this.audit.record(
        { actorId: p.userId, action: "integrity.submissions.list", entity: "assessment", entityId: assessmentId, schoolId: p.schoolId, metadata: { count: subs.length } },
        tx,
      );
      return subs.map<AssessmentSubmissionDto>((s) => ({
        id: s.id,
        studentId: s.studentId,
        studentName: nameById.get(s.studentId) ?? null,
        status: s.status,
        submittedAt: s.submittedAt,
        signalCount: signalCount.get(s.id) ?? 0,
        hasFile: s.fileUploaded,
        fileName: s.fileName,
      }));
    });
  }

  /** Create an assessment (teacher of the class / school-wide). */
  async createAssessment(
    p: Principal,
    input: {
      title: string;
      description?: string | null;
      classId?: string | null;
      integrityEnabled?: boolean;
      pasteBlocked?: boolean;
      focusTracked?: boolean;
      typingTracked?: boolean;
      fileUploadEnabled?: boolean;
      timed?: boolean;
      durationMinutes?: number | null;
      opensAt?: string | null;
      closesAt?: string | null;
    },
  ): Promise<AssessmentSummaryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.classId) await this.assertTeacherOfClass(tx, p, input.classId);
      // Tag to the CURRENT term so graded submissions scope to it on the report
      // card. Null when no current term is set (reads as all-time — fail-open).
      const currentTerm = await tx.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
      const a = await tx.assessment.create({
        data: {
          schoolId: p.schoolId,
          termId: currentTerm?.id ?? null,
          title: input.title,
          description: input.description ?? null,
          classId: input.classId ?? null,
          createdById: p.userId,
          integrityEnabled: input.integrityEnabled ?? false,
          pasteBlocked: input.pasteBlocked ?? false,
          focusTracked: input.focusTracked ?? false,
          typingTracked: input.typingTracked ?? false,
          fileUploadEnabled: input.fileUploadEnabled ?? false,
          timed: input.timed ?? false,
          durationMinutes: input.durationMinutes ?? null,
          opensAt: input.opensAt ? new Date(input.opensAt) : null,
          closesAt: input.closesAt ? new Date(input.closesAt) : null,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "integrity.assessment.create", entity: "assessment", entityId: a.id, schoolId: p.schoolId, metadata: { fileUploadEnabled: a.fileUploadEnabled } },
        tx,
      );
      return this.summary(a, p);
    });
  }

  /** Update an assessment's metadata + toggles (incl. fileUploadEnabled). */
  async updateAssessment(
    p: Principal,
    id: string,
    input: {
      title?: string;
      description?: string | null;
      integrityEnabled?: boolean;
      pasteBlocked?: boolean;
      focusTracked?: boolean;
      typingTracked?: boolean;
      fileUploadEnabled?: boolean;
    },
  ): Promise<AssessmentSummaryDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const assessment = await tx.assessment.findFirst({ where: { id } });
      if (!assessment) throw new NotFoundException("Assessment not found");
      if (!(await this.canManage(tx, p, assessment))) throw new NotFoundException("Assessment not found");
      const a = await tx.assessment.update({
        where: { id },
        data: {
          title: input.title ?? undefined,
          description: input.description === undefined ? undefined : input.description,
          integrityEnabled: input.integrityEnabled ?? undefined,
          pasteBlocked: input.pasteBlocked ?? undefined,
          focusTracked: input.focusTracked ?? undefined,
          typingTracked: input.typingTracked ?? undefined,
          fileUploadEnabled: input.fileUploadEnabled ?? undefined,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "integrity.assessment.update", entity: "assessment", entityId: id, schoolId: p.schoolId, metadata: { fileUploadEnabled: a.fileUploadEnabled } },
        tx,
      );
      return this.summary(a, p);
    });
  }

  private summary(
    a: { id: string; title: string; description: string | null; classId: string | null; createdById: string; integrityEnabled: boolean; fileUploadEnabled: boolean; createdAt: Date },
    p: Principal,
  ): AssessmentSummaryDto {
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      classId: a.classId,
      className: null,
      createdById: a.createdById,
      mine: a.createdById === p.userId,
      integrityEnabled: a.integrityEnabled,
      fileUploadEnabled: a.fileUploadEnabled,
      submissionCount: 0,
      mySubmissionStatus: null,
      createdAt: a.createdAt,
    };
  }

  /** A non-school-wide user must teach the class to attach an assessment to it. */
  private async assertTeacherOfClass(tx: TenantTx, p: Principal, classId: string): Promise<void> {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    if (this.schoolWide(p)) return;
    const t = await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } });
    if (!t) throw new ForbiddenException("You do not teach that class");
  }

  private async canManage(tx: TenantTx, p: Principal, assessment: { createdById: string; classId: string | null }): Promise<boolean> {
    if (this.schoolWide(p)) return true;
    if (assessment.createdById === p.userId) return true;
    if (assessment.classId) {
      const t = await tx.classTeacher.findFirst({ where: { classId: assessment.classId, teacherId: p.userId }, select: { id: true } });
      if (t) return true;
    }
    return false;
  }
}
