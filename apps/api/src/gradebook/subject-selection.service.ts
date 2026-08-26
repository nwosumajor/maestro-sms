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
import type { SubjectSelectionDto, SubjectSelectionOptionsDto, SubjectSelectionPageDto } from "@sms/types";
import { LMS_PERMISSIONS , supervisorStage} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "principal"]);

/** The two statuses that mean "nobody has dealt with this yet". */
const OPEN_STATUSES = ["PENDING_SUPERVISOR", "PENDING_ADMIN"] as const;

/** Name lookups shared across a whole page of selections. */
type SelectionNames = {
  subject: Map<string, string>;
  term: Map<string, string>;
  class: Map<string, string>;
  user: Map<string, string>;
};
const SELECTION_PAGE_SIZE = 50;

/**
 * Can this caller SEE selections beyond their own or their supervisees'?
 *
 * Shared by `list` and `review` so the two cannot drift. They had drifted:
 * `list` shows every selection to a school-wide role OR an approver, while
 * `review` refused anyone without `subject.selection.approve` with a 404. A
 * principal is school-wide and deliberately does NOT hold that permission — so
 * they saw a pending queue on their own screen, pressed Approve, and were told
 * the selection does not exist. Live: `list` 200 with the row, `review` 404.
 *
 * A 404 is right for somebody who cannot see the record; it is the rule that
 * stops a refusal confirming what it hides. It is wrong for somebody the
 * product has already shown it to — that denies what it has already shown, and
 * reads as a broken screen rather than as a boundary.
 */
function seesEverySelection(p: Principal): boolean {
  return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r)) || p.permissions.includes(LMS_PERMISSIONS.SUBJECT_SELECTION_APPROVE);
}

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

  /**
   * The four name lookups a page of selections needs, resolved ONCE.
   *
   * // GOTCHA: `toDto` used to run them per row, and `list` called it through
   * `Promise.all(rows.map(...))`. Measured live on one term of a 901-pupil
   * school, a single 50-row page cost **205 queries** — 50 reads of `term`, 50
   * of `class`, 50 of `subject` and 55 of `user` — in 211 ms. A cohort shares
   * its term and its class, so 49 of each 50 were the SAME ROW fetched again.
   * Widening the page would have multiplied it; the paging fix that preceded
   * this made the per-row cost matter more, not less.
   */
  private async namesFor(tx: TenantTx, rows: SelectionRow[]): Promise<SelectionNames> {
    const subjectIds = new Set<string>();
    const termIds = new Set<string>();
    const classIds = new Set<string>();
    const userIds = new Set<string>();
    for (const r of rows) {
      for (const id of ((r.subjectIds as string[]) ?? [])) subjectIds.add(id);
      termIds.add(r.termId);
      classIds.add(r.classId);
      userIds.add(r.studentId);
      if (r.supervisorId) userIds.add(r.supervisorId);
    }
    const [subjects, terms, classes, people] = await Promise.all([
      subjectIds.size
        ? tx.subject.findMany({ where: { id: { in: [...subjectIds] } }, select: { id: true, name: true } })
        : [],
      termIds.size ? tx.term.findMany({ where: { id: { in: [...termIds] } }, select: { id: true, name: true } }) : [],
      classIds.size ? tx.class.findMany({ where: { id: { in: [...classIds] } }, select: { id: true, name: true } }) : [],
      userIds.size ? tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    ]);
    const map = (rs: Array<{ id: string; name: string }>) => new Map(rs.map((r) => [r.id, r.name]));
    return { subject: map(subjects), term: map(terms), class: map(classes), user: map(people) };
  }

  /** One row, when the caller has only one — reuses the batch resolver. */
  private async toDto(tx: TenantTx, row: SelectionRow): Promise<SubjectSelectionDto> {
    return this.toDtoWith(row, await this.namesFor(tx, [row]));
  }

  private toDtoWith(row: SelectionRow, names: SelectionNames): SubjectSelectionDto {
    const subjectIds = (row.subjectIds as string[]) ?? [];
    const term = { name: names.term.get(row.termId) };
    const klass = { name: names.class.get(row.classId) };
    const nameById = names.user;
    // Preserve the student's pick order.
    const subjName = names.subject;
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
      supervisorStage: supervisorStage(row),
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
  /**
   * Student -> own; supervisor -> rows naming them; approvers/school-wide ->
   * all. Others see nothing.
   *
   * `filter=open` is the REVIEW QUEUE and is ordered OLDEST FIRST — the pupil
   * who has been waiting longest is the one to deal with next. Everything else
   * is newest-first, which is what a history wants.
   *
   * // GOTCHA: this used to be `take: 200` with no filter, no page and no
   * total, and the panel decided "is anything awaiting me" with a `.filter()`
   * over what came back. Selections are bounded by the COHORT, not by the
   * school's lifetime — one term of a 901-pupil school is 901 rows — so the cap
   * is passed in the first term. And `updatedAt DESC` is bumped BY A REVIEW, so
   * every decision pushed the un-reviewed rows further out of sight: measured
   * live, 21 pupils awaiting approval, 200 rows returned, all APPROVED, and the
   * panel reading "Nothing awaiting review." Only APPROVED selections feed the
   * grading roster, so those 21 were also off it.
   */
  async list(
    p: Principal,
    opts: { filter?: "open" | "decided"; page?: number } = {},
  ): Promise<SubjectSelectionPageDto> {
    const pageSize = SELECTION_PAGE_SIZE;
    const page = Math.max(1, opts.page ?? 1);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const wide = seesEverySelection(p);
      const scope = wide
        ? {}
        : p.roles.includes("student")
          ? { studentId: p.userId }
          : { supervisorId: p.userId };
      const byFilter =
        opts.filter === "open"
          ? { status: { in: [...OPEN_STATUSES] } }
          : opts.filter === "decided"
            ? { status: { notIn: [...OPEN_STATUSES] } }
            : {};
      const where = { ...scope, ...byFilter };
      const [rows, total, pendingTotal] = await Promise.all([
        tx.subjectSelection.findMany({
          where,
          // Oldest first ON THE QUEUE only: a review queue is worked from the
          // front, and the longest wait is the one that matters.
          orderBy: opts.filter === "open" ? { createdAt: "asc" } : { updatedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }) as Promise<SelectionRow[]>,
        tx.subjectSelection.count({ where }),
        // Counted over the caller's WHOLE scope, never narrowed by the filter
        // or the page — a count a filter can change is a count a filter can
        // hide, and this one answers "is anything waiting on us".
        tx.subjectSelection.count({ where: { ...scope, status: { in: [...OPEN_STATUSES] } } }),
      ]);
      // ONE resolve for the page, not one per row.
      const names = await this.namesFor(tx, rows);
      const items = rows.map((r) => this.toDtoWith(r, names));
      return { items, total, pendingTotal, page, pageSize };
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
      // WHO MAY BE TOLD WHY, as against who may only be told nothing. A caller
      // who can already read this row in `list` gets a reason; everybody else
      // gets the same "not found" they would get for another school's record.
      const visible = seesEverySelection(p) || row.supervisorId === p.userId;
      if (row.status === "PENDING_SUPERVISOR") {
        // Stage 1: ONLY the named class supervisor.
        if (row.supervisorId !== p.userId) {
          if (!visible) throw new NotFoundException("Selection not found");
          throw new ForbiddenException("This is with the class supervisor for the first approval.");
        }
        fromStatus = "PENDING_SUPERVISOR";
        data =
          input.action === "APPROVE"
            ? { status: "PENDING_ADMIN", supervisorActedById: p.userId, reviewNote: input.note ?? null }
            : { status: "REJECTED", supervisorActedById: p.userId, reviewedById: p.userId, reviewNote: input.note ?? null };
      } else if (row.status === "PENDING_ADMIN") {
        // Stage 2: school_admin / head_teacher — and never the same person who
        // passed stage 1 (separation of duties).
        if (!p.permissions.includes(LMS_PERMISSIONS.SUBJECT_SELECTION_APPROVE)) {
          // NOT a 404 for somebody looking at it on their own screen. A
          // principal is school-wide and deliberately does not hold this
          // permission — the final approval belongs to a school administrator
          // or head teacher — so say that rather than deny the record exists.
          if (!visible) throw new NotFoundException("Selection not found");
          throw new ForbiddenException(
            "The final approval is given by a school administrator or head teacher.",
          );
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
        // A TERMINAL STATUS IS STILL INFORMATION. This threw the status at
        // anybody, with no visibility check at all — and the route gate is
        // `class.read`, which every teacher holds. So any teacher could put an
        // id in and learn that a selection exists and has been APPROVED, for a
        // pupil in a class that is nothing to do with them. Live before this:
        // a teacher whose own list returned ZERO rows got
        // `409 This selection is already APPROVED`.
        if (!visible) throw new NotFoundException("Selection not found");
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
