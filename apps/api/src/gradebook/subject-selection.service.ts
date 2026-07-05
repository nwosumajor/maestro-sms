// =============================================================================
// SubjectSelectionService — per-term subject choice, 2-stage maker-checker
// =============================================================================
// A student picks their term's subjects from the set FIXED on their class by
// admin/principal (ClassSubjectTeacher offerings). The selection then passes:
//   stage 1 — the class's SPECIFIC supervisor (Class.supervisorId — a named
//             person, so this is an on-row maker-checker like admissions /
//             promotions, NOT a role-based workflow-engine route; skipped when
//             the class has no supervisor), then
//   stage 2 — a holder of subject.selection.approve (school_admin/head_teacher)
//             who must be a DIFFERENT person from stage 1 (separation of
//             duties).
// Only APPROVED selections feed the grading roster (TermResultService reads
// them). One row per (term, student); REJECTED resubmits in place. Statuses:
// PENDING_SUPERVISOR -> PENDING_ADMIN -> APPROVED | REJECTED. Transitions are
// optimistic (updateMany on id+status) so two concurrent reviews can't both
// land. Cross-tenant / not-visible -> 404. Every mutation audit-logged.
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
import type { SubjectSelectionDto, SubjectSelectionOptionsDto } from "@sms/types";
import { LMS_PERMISSIONS } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin", "principal"]);

interface SelectionRow {
  id: string;
  sessionId: string;
  termId: string;
  classId: string;
  studentId: string;
  subjectIds: unknown;
  status: string;
  supervisorId: string | null;
  supervisorActedById: string | null;
  reviewedById: string | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SubjectSelectionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private async toDto(tx: TenantTx, row: SelectionRow): Promise<SubjectSelectionDto> {
    const subjectIds = (row.subjectIds as string[]) ?? [];
    const [subjects, term, klass, people] = await Promise.all([
      tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
      tx.term.findFirst({ where: { id: row.termId }, select: { name: true } }),
      tx.class.findFirst({ where: { id: row.classId }, select: { name: true } }),
      tx.user.findMany({
        where: { id: { in: [row.studentId, row.supervisorId ?? row.studentId] } },
        select: { id: true, name: true },
      }),
    ]);
    const nameById = new Map(people.map((u) => [u.id, u.name]));
    // Preserve the student's pick order.
    const subjName = new Map(subjects.map((s) => [s.id, s.name]));
    return {
      id: row.id,
      sessionId: row.sessionId,
      termId: row.termId,
      termName: term?.name ?? "",
      classId: row.classId,
      className: klass?.name ?? "",
      studentId: row.studentId,
      studentName: nameById.get(row.studentId) ?? "Unknown",
      subjects: subjectIds.map((id) => ({ id, name: subjName.get(id) ?? "Unknown" })),
      status: row.status,
      supervisorId: row.supervisorId,
      supervisorName: row.supervisorId ? (nameById.get(row.supervisorId) ?? null) : null,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Student: what can I pick, and what have I picked?
  // ---------------------------------------------------------------------------
  async getOptions(p: Principal): Promise<SubjectSelectionOptionsDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const empty: SubjectSelectionOptionsDto = {
        sessionId: null, sessionName: null, termId: null, termName: null,
        classId: null, className: null, offered: [], selection: null,
      };
      const term = await tx.term.findFirst({
        where: { isCurrent: true },
        select: { id: true, name: true, sessionId: true },
      });
      const session = term
        ? await tx.academicSession.findFirst({ where: { id: term.sessionId }, select: { id: true, name: true } })
        : await tx.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
      const enrollment = await tx.enrollment.findFirst({
        where: { studentId: p.userId, status: "ACTIVE" },
        select: { classId: true },
        orderBy: { enrolledAt: "desc" },
      });
      if (!enrollment) return { ...empty, sessionId: session?.id ?? null, sessionName: session?.name ?? null, termId: term?.id ?? null, termName: term?.name ?? null };
      const klass = await tx.class.findFirst({ where: { id: enrollment.classId }, select: { id: true, name: true } });

      // The pickable set = the class's admin-fixed offerings.
      const offerings = await tx.classSubjectTeacher.findMany({
        where: { classId: enrollment.classId },
        select: { subjectId: true, teacherId: true },
      });
      const [subjects, teachers] = await Promise.all([
        tx.subject.findMany({ where: { id: { in: offerings.map((o) => o.subjectId) } }, select: { id: true, name: true } }),
        tx.user.findMany({ where: { id: { in: offerings.map((o) => o.teacherId) } }, select: { id: true, name: true } }),
      ]);
      const subjName = new Map(subjects.map((s) => [s.id, s.name]));
      const teachName = new Map(teachers.map((t) => [t.id, t.name]));

      const existing = term
        ? ((await tx.subjectSelection.findFirst({
            where: { termId: term.id, studentId: p.userId },
          })) as SelectionRow | null)
        : null;

      return {
        sessionId: session?.id ?? null,
        sessionName: session?.name ?? null,
        termId: term?.id ?? null,
        termName: term?.name ?? null,
        classId: klass?.id ?? null,
        className: klass?.name ?? null,
        offered: offerings
          .map((o) => ({
            subjectId: o.subjectId,
            subjectName: subjName.get(o.subjectId) ?? "Unknown",
            teacherName: teachName.get(o.teacherId) ?? "Unknown",
          }))
          .sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
        selection: existing ? await this.toDto(tx, existing) : null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Student submits (or resubmits after rejection)
  // ---------------------------------------------------------------------------
  async submit(p: Principal, input: { termId: string; subjectIds: string[] }): Promise<SubjectSelectionDto> {
    const picked = [...new Set(input.subjectIds)];
    if (picked.length === 0) throw new BadRequestException("Pick at least one subject");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const term = await tx.term.findFirst({
        where: { id: input.termId },
        select: { id: true, sessionId: true },
      });
      if (!term) throw new NotFoundException("Term not found");
      const enrollment = await tx.enrollment.findFirst({
        where: { studentId: p.userId, status: "ACTIVE" },
        select: { classId: true },
        orderBy: { enrolledAt: "desc" },
      });
      if (!enrollment) throw new BadRequestException("You are not enrolled in a class");
      const klass = await tx.class.findFirst({
        where: { id: enrollment.classId },
        select: { id: true, supervisorId: true },
      });
      if (!klass) throw new NotFoundException("Class not found");

      // Every pick must be a subject the admin/principal FIXED on this class.
      const offered = await tx.classSubjectTeacher.findMany({
        where: { classId: klass.id, subjectId: { in: picked } },
        select: { subjectId: true },
      });
      if (offered.length !== picked.length) {
        throw new BadRequestException("Every subject must be one offered on your class");
      }

      const existing = (await tx.subjectSelection.findFirst({
        where: { termId: term.id, studentId: p.userId },
      })) as SelectionRow | null;
      if (existing && existing.status !== "REJECTED") {
        throw new ConflictException(
          existing.status === "APPROVED"
            ? "Your subjects for this term are already approved."
            : "Your selection is already awaiting approval.",
        );
      }

      // Stage 1 is the class's CURRENT supervisor; no supervisor -> straight to
      // the admin stage (the flow must not strand on unconfigured classes).
      const supervisorId = klass.supervisorId ?? null;
      const status = supervisorId ? "PENDING_SUPERVISOR" : "PENDING_ADMIN";
      const data = {
        sessionId: term.sessionId,
        classId: klass.id,
        subjectIds: picked as unknown as Prisma.InputJsonValue,
        status,
        supervisorId,
        supervisorActedById: null,
        reviewedById: null,
        reviewNote: null,
      };
      const row = (existing
        ? await tx.subjectSelection.update({ where: { id: existing.id }, data })
        : await tx.subjectSelection.create({
            data: { schoolId: p.schoolId, termId: term.id, studentId: p.userId, ...data },
          })) as SelectionRow;
      await this.audit.record(
        {
          actorId: p.userId,
          action: existing ? "gradebook.subject-selection.resubmit" : "gradebook.subject-selection.submit",
          entity: "subject_selection",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { termId: term.id, subjects: picked.length, status },
        },
        tx,
      );
      return this.toDto(tx, row);
    });
  }

  // ---------------------------------------------------------------------------
  // Reads (scoped)
  // ---------------------------------------------------------------------------
  /** Student -> own; supervisor -> rows naming them; approvers/school-wide ->
   *  all. Others see nothing. */
  async list(p: Principal): Promise<SubjectSelectionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const wide =
        p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r)) ||
        p.permissions.includes(LMS_PERMISSIONS.SUBJECT_SELECTION_APPROVE);
      const where = wide
        ? {}
        : p.roles.includes("student")
          ? { studentId: p.userId }
          : { supervisorId: p.userId };
      const rows = (await tx.subjectSelection.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 200,
      })) as SelectionRow[];
      return Promise.all(rows.map((r) => this.toDto(tx, r)));
    });
  }

  // ---------------------------------------------------------------------------
  // Review — the two stages
  // ---------------------------------------------------------------------------
  async review(
    p: Principal,
    id: string,
    input: { action: "APPROVE" | "REJECT"; note?: string },
  ): Promise<SubjectSelectionDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.subjectSelection.findFirst({ where: { id } })) as SelectionRow | null;
      if (!row) throw new NotFoundException("Selection not found");
      if (row.studentId === p.userId) {
        throw new ForbiddenException("You cannot review your own selection");
      }

      let data: Record<string, unknown>;
      let fromStatus: string;
      if (row.status === "PENDING_SUPERVISOR") {
        // Stage 1: ONLY the named class supervisor. 404 (not 403) for anyone
        // else — don't reveal whose queue it sits in.
        if (row.supervisorId !== p.userId) throw new NotFoundException("Selection not found");
        fromStatus = "PENDING_SUPERVISOR";
        data =
          input.action === "APPROVE"
            ? { status: "PENDING_ADMIN", supervisorActedById: p.userId, reviewNote: input.note ?? null }
            : { status: "REJECTED", supervisorActedById: p.userId, reviewedById: p.userId, reviewNote: input.note ?? null };
      } else if (row.status === "PENDING_ADMIN") {
        // Stage 2: school_admin / head_teacher — and never the same person who
        // passed stage 1 (separation of duties).
        if (!p.permissions.includes(LMS_PERMISSIONS.SUBJECT_SELECTION_APPROVE)) {
          throw new NotFoundException("Selection not found");
        }
        if (row.supervisorActedById === p.userId) {
          throw new ForbiddenException("A different person must give the final approval");
        }
        fromStatus = "PENDING_ADMIN";
        data = {
          status: input.action === "APPROVE" ? "APPROVED" : "REJECTED",
          reviewedById: p.userId,
          reviewNote: input.note ?? null,
        };
      } else {
        throw new ConflictException(`This selection is already ${row.status}`);
      }

      // Optimistic claim: a concurrent reviewer moved it -> 0 rows -> conflict.
      const written = await tx.subjectSelection.updateMany({
        where: { id, status: fromStatus },
        data,
      });
      if (written.count === 0) {
        throw new ConflictException("This selection was just updated by someone else — reload and try again.");
      }
      await this.audit.record(
        {
          actorId: p.userId,
          action: `gradebook.subject-selection.${input.action.toLowerCase()}`,
          entity: "subject_selection",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { stage: fromStatus, to: data.status, studentId: row.studentId },
        },
        tx,
      );
      const fresh = (await tx.subjectSelection.findFirst({ where: { id } })) as SelectionRow;
      return this.toDto(tx, fresh);
    });
  }
}
