// =============================================================================
// DisciplineService — complaint intake + resolution
// =============================================================================
// Tenant-scoped (RLS). Anyone (discipline.file) files a complaint against a
// student/teacher and sees their OWN filed complaints. Staff (discipline.manage)
// see all, assign responsible resolvers, attach evidence (object storage), add
// action notes, and record a resolution. SECURITY (Golden Rule #8): this records
// HUMAN decisions only — it never auto-penalises. Evidence on minors is sensitive,
// so all reads of a complaint are audited. 404 (not 403) for out-of-scope access.
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { DisciplineComplaintDto, DisciplineEvidencePresignDto, IdNameDto, PageDto } from "@sms/types";
import { decodeCursor, pageLimit, seekWhere, toPage } from "../common/keyset-cursor";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
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

const STATUSES = ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"];
// Picker/typeahead cap — a target list never ships a whole large-school roster.
const TARGET_CAP = 500;

/** Roles that may see the school's STAFF-conduct cases. See canHandleStaffCase. */
const STAFF_CASE_ROLES = new Set(["principal", "school_admin"]);

@Injectable()
export class DisciplineService {
  private readonly logger = new Logger("Discipline");
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private canManage(p: Principal): boolean {
    return p.permissions.includes("discipline.manage");
  }

  /**
   * Who may handle a complaint about a MEMBER OF STAFF.
   *
   * `discipline.manage` is held by every classroom teacher, which is right for
   * cases about pupils and wrong for cases about colleagues: a pupil reporting a
   * teacher's conduct expects that to reach leadership, not the staffroom. A
   * staff-conduct case is therefore school-wide-visible only to these roles.
   * Anyone else still sees such a case if they FILED it or were ASSIGNED it.
   */
  private canHandleStaffCase(p: Principal): boolean {
    return p.roles.some((r) => STAFF_CASE_ROLES.has(r));
  }

  /**
   * Which complaints this caller may see.
   *
   * A manager sees the school's. Everyone else sees the ones they FILED — and,
   * now, the ones they have been ASSIGNED.
   *
   * That last clause was missing entirely. `assign` accepts any user in the
   * school, but `assigneeId` was only ever written: it appeared in no read scope
   * anywhere, and nothing notified the person. So assigning a case to a teacher
   * told them nothing and showed them nothing — the list omitted it and fetching
   * it by id returned 404. The row existed and did nothing, which is worse than
   * having no assignment feature, because the manager believes it was handed on.
   *
   * Deliberately narrow: it grants sight of the complaints assigned to THAT
   * person and nothing else. These are records about children and the default
   * stays closed.
   */
  private async visibleComplaintWhere(tx: TenantTx, p: Principal): Promise<Record<string, unknown>> {
    // SECURITY: a complaint is never visible to the person it is ABOUT (see
    // below). Leadership sees everything else, so it needs no further lookup.
    const notAboutMe = { NOT: { againstId: p.userId } };
    if (this.canManage(p) && this.canHandleStaffCase(p)) return notAboutMe;

    const buckets: Record<string, unknown>[] = [{ complainantId: p.userId }];
    const mine = await tx.disciplineAssignee.findMany({
      where: { assigneeId: p.userId },
      select: { complaintId: true },
    });
    if (mine.length > 0) buckets.push({ id: { in: mine.map((a) => a.complaintId) } });
    if (this.canManage(p)) {
      buckets.push(this.canHandleStaffCase(p) ? {} : { againstType: "STUDENT" });
    }
    // Without the NOT, `discipline.manage` — which every teacher has — let an
    // accused teacher read the case against them, see the pupil who filed it BY
    // NAME, and dismiss it themselves. The accused being told is a deliberate
    // act by whoever handles the case, not a side effect of a permission they
    // happen to carry.
    return { AND: [notAboutMe, { OR: buckets }] };
  }

  /**
   * Load a complaint this caller is allowed to SEE, or 404.
   *
   * Every door — read, assign, entry, resolve, evidence — goes through this one
   * predicate. They used to disagree: `list` filtered by scope, `get` re-derived
   * a similar rule inline, and every mutation used a bare lookup by id that
   * applied no scope whatsoever.
   */
  private async requireVisible(
    tx: TenantTx,
    p: Principal,
    complaintId: string,
  ): Promise<{ id: string; againstId: string; againstType: string }> {
    const where = await this.visibleComplaintWhere(tx, p);
    const c = await tx.disciplineComplaint.findFirst({
      where: { AND: [{ id: complaintId }, where] },
      select: { id: true, againstId: true, againstType: true },
    });
    // 404-not-403 throughout: whether a complaint exists about somebody is
    // itself something a caller outside the case should not learn.
    if (!c) throw new NotFoundException("Complaint not found");
    return c;
  }

  // --- file (anyone) --------------------------------------------------------

  async file(
    p: Principal,
    input: { subject: string; details?: string; againstId: string; againstType: "STUDENT" | "TEACHER" },
  ): Promise<DisciplineComplaintDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const against = await tx.user.findFirst({ where: { id: input.againstId }, select: { id: true } });
      if (!against) throw new NotFoundException("The named person is not in this school");
      // A complaint about yourself is either a mistake or an attempt to create a
      // case the scope below then hides from you.
      if (input.againstId === p.userId) throw new BadRequestException("You cannot file a complaint against yourself");
      // SECURITY: a non-manager may only file against someone in their own
      // relationship scope (a classmate, or a teacher who teaches them / their
      // child). This is the server-side backstop for the scoped picker — a filer
      // can't name an arbitrary in-school user by guessing an id. 404-not-403 so
      // an out-of-scope target is indistinguishable from a non-existent one.
      if (!this.canManage(p) && !(await this.isAllowedTarget(tx, p, input.againstId, input.againstType))) {
        throw new NotFoundException("The named person is not in this school");
      }
      const c = await tx.disciplineComplaint.create({
        data: {
          schoolId: p.schoolId,
          subject: input.subject,
          details: input.details ?? null,
          complainantId: p.userId,
          againstId: input.againstId,
          againstType: input.againstType,
          status: "OPEN",
        },
      });
      await this.log(tx, p, "discipline.file", c.id, { againstType: input.againstType });
      return this.complaintDto(tx, c.id);
    });
  }

  // --- staff review ---------------------------------------------------------

  async assign(p: Principal, complaintId: string, assigneeId: string): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    const dto = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      const u = await tx.user.findFirst({ where: { id: assigneeId }, select: { id: true } });
      if (!u) throw new NotFoundException("Assignee not found in this school");
      const dup = await tx.disciplineAssignee.findFirst({ where: { complaintId, assigneeId }, select: { id: true } });
      if (dup) throw new BadRequestException("Already assigned");
      await tx.disciplineAssignee.create({ data: { schoolId: p.schoolId, complaintId, assigneeId } });
      await this.log(tx, p, "discipline.assign", complaintId, { assigneeId });
      return this.complaintDto(tx, complaintId);
    });
    // TELL THEM. Handing a case to somebody who is never informed is not
    // handing it on; the case simply sits. Deliberately says nothing about the
    // substance — these are records about children, and the notification is a
    // pointer, not a summary.
    //
    // AFTER the transaction, and never fatal. Enqueuing inside it got the
    // ordering backwards twice over: the notification commits in a transaction
    // of its own, so a later failure in this one told somebody they had been
    // given a case that was never assigned — and a queue that was merely
    // unreachable made the assignment itself impossible.
    await this.tell(assigneeId, p, {
      complaintId,
      title: "A discipline case has been assigned to you",
      body: "You are now responsible for a discipline case. Open Discipline to see the details.",
    });
    return dto;
  }

  /** Best-effort notice about a case. A failure here is logged, never raised:
   *  the assignment is already real, and telling somebody about it must not be
   *  able to undo it. */
  private async tell(
    recipientId: string,
    p: Principal,
    msg: { complaintId: string; title: string; body: string },
  ): Promise<void> {
    try {
      await this.notifications.enqueue(
        { schoolId: p.schoolId, userId: p.userId },
        {
          recipientId,
          type: "WORKFLOW_UPDATE",
          title: msg.title,
          body: msg.body,
          data: { complaintId: msg.complaintId },
        },
      );
    } catch (e) {
      this.logger.warn(`discipline notice to ${recipientId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Take a case back off somebody.
   *
   * Assignment is an ACCESS GRANT, not a label: `downloadEvidence` lets a
   * non-manager through purely because they are an assignee, so assigning the
   * wrong person hands them the evidence files on a case about a child. There
   * was an assign endpoint and nothing to undo it — the row had no status, no
   * update path and no delete anywhere in the codebase, so a mis-typed name in a
   * picker was permanent.
   *
   * // SECURITY: audited, like the assignment. `requireVisible` first, so this
   * cannot be used to probe for cases the caller cannot see, and an assignment
   * that is not there is a 404 rather than a silent success — "already
   * unassigned" and "no such case" must not be distinguishable from outside.
   *
   * The person losing the case IS told, unlike a guardian being unlinked: they
   * were told when they got it, they may be part-way through working it, and a
   * case that silently vanishes from someone's list is how a case gets dropped.
   */
  async unassign(p: Principal, complaintId: string, assigneeId: string): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    const dto = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      const row = await tx.disciplineAssignee.findFirst({
        where: { complaintId, assigneeId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException("Assignment not found");
      await tx.disciplineAssignee.delete({ where: { id: row.id } });
      await this.log(tx, p, "discipline.unassign", complaintId, { assigneeId });
      return this.complaintDto(tx, complaintId);
    });
    await this.tell(assigneeId, p, {
      complaintId,
      title: "A discipline case is no longer assigned to you",
      body: "You are no longer responsible for a discipline case you had been given.",
    });
    return dto;
  }

  async addEntry(p: Principal, complaintId: string, body: string): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      await tx.disciplineEntry.create({ data: { schoolId: p.schoolId, complaintId, authorId: p.userId, body } });
      await this.log(tx, p, "discipline.entry", complaintId, {});
      return this.complaintDto(tx, complaintId);
    });
  }

  /** Record an action/resolution + status. Human decision only (Golden Rule #8). */
  /**
   * Record the human decision on a complaint.
   *
   * TWO THINGS THIS DELIBERATELY DOES BEYOND WRITING THE ROW.
   *
   * 1. IT TELLS THE FAMILY. A disciplinary outcome is a permanent record against
   *    a child's name, and until now nothing in this module notified anyone at
   *    all — a sanction could be recorded, and later revised, with the guardians
   *    never told. Notified on the DECISION, not on filing: a complaint is an
   *    allegation nobody has reviewed yet, and alerting a parent the instant
   *    anyone files one would both pre-judge it and hand a malicious filer a way
   *    to upset a family at will.
   *
   * 2. IT KEEPS THE PREVIOUS DECISION. `resolution` is a mutable column, so a
   *    recorded outcome could be overwritten and the earlier one would simply be
   *    gone. Any change to an already-decided complaint now writes an APPEND-ONLY
   *    entry naming what it was, what it became and who changed it. The entry
   *    table cannot be edited, so the history of a child's record is
   *    tamper-evident even though the current value is not immutable.
   */
  async resolve(p: Principal, complaintId: string, input: { status: string; resolution?: string }): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    if (!STATUSES.includes(input.status)) throw new BadRequestException("invalid status");
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      const before = (await tx.disciplineComplaint.findFirst({
        where: { id: complaintId },
        select: { status: true, resolution: true, againstId: true, againstType: true, subject: true },
      })) as {
        status: string; resolution: string | null; againstId: string; againstType: string; subject: string;
      } | null;
      if (!before) throw new NotFoundException("Not found");

      // Revising a decision that was already recorded: keep the old one.
      const wasDecided = before.status === "RESOLVED" || before.status === "DISMISSED";
      const resolutionChanged =
        input.resolution !== undefined && (before.resolution ?? "") !== input.resolution;
      if (wasDecided && (before.status !== input.status || resolutionChanged)) {
        await tx.disciplineEntry.create({
          data: {
            schoolId: p.schoolId,
            complaintId,
            authorId: p.userId,
            body:
              `Decision revised: ${before.status} → ${input.status}.` +
              (resolutionChanged ? ` Previous outcome recorded: "${before.resolution ?? "(none)"}".` : ""),
          },
        });
      }

      await tx.disciplineComplaint.update({
        where: { id: complaintId },
        data: { status: input.status, ...(input.resolution !== undefined ? { resolution: input.resolution } : {}) },
      });
      await this.log(tx, p, "discipline.resolve", complaintId, {
        status: input.status,
        previousStatus: before.status,
        revisedDecision: wasDecided,
      });

      // Who to tell. A student's guardians as well as the student; a teacher only
      // themselves — a colleague's disciplinary matter is not the school's news.
      let recipients: string[] = [];
      if (before.againstType === "STUDENT") {
        const guardians = (await tx.parentChild.findMany({
          where: { studentId: before.againstId },
          select: { parentId: true },
        })) as Array<{ parentId: string }>;
        recipients = [...new Set([before.againstId, ...guardians.map((g) => g.parentId)])];
      } else {
        recipients = [before.againstId];
      }
      const dto = await this.complaintDto(tx, complaintId);
      return { dto, recipients, before, decided: input.status === "RESOLVED" || input.status === "DISMISSED" };
    });

    // AFTER the committed write, like every other notify path here: a delivery
    // failure must never undo a recorded decision.
    if (outcome.decided && outcome.recipients.length > 0) {
      const title =
        outcome.before.againstType === "STUDENT"
          ? "A disciplinary matter has been concluded"
          : "A disciplinary matter concerning you has been concluded";
      try {
        await this.notifications.enqueueMany(this.ctx(p), outcome.recipients, {
          type: "DISCIPLINE_OUTCOME",
          title,
          body: `"${outcome.before.subject}" was concluded. Please contact the school office for the details.`,
          data: { complaintId },
        });
      } catch {
        // Best effort — see above.
      }
    }
    return outcome.dto;
  }

  // --- evidence -------------------------------------------------------------

  async presignEvidence(p: Principal, complaintId: string, input: { fileName: string; contentType: string }): Promise<DisciplineEvidencePresignDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      const safe = input.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
      const key = `discipline/${p.schoolId}/${complaintId}/${Date.now()}_${safe}`;
      const { url } = await this.storage.presignUpload({ key, contentType: input.contentType });
      return { url, key };
    });
  }

  async confirmEvidence(p: Principal, complaintId: string, input: { key: string; fileName: string }): Promise<DisciplineComplaintDto> {
    this.requireManage(p);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      const prefix = `discipline/${p.schoolId}/${complaintId}/`;
      if (!input.key.startsWith(prefix)) throw new BadRequestException("key does not match this complaint");
      await tx.disciplineEvidence.create({ data: { schoolId: p.schoolId, complaintId, uploadedById: p.userId, fileKey: input.key, fileName: input.fileName } });
      await this.log(tx, p, "discipline.evidence", complaintId, { fileName: input.fileName });
      return this.complaintDto(tx, complaintId);
    });
  }

  /**
   * Open a piece of evidence.
   *
   * MANAGERS and the case's ASSIGNEES. It used to be managers alone, while the
   * case detail already LISTED the evidence — filename and uploader — to anyone
   * who could see the case. So the person made responsible for resolving a
   * disciplinary matter about a child was shown "photo-of-incident.jpg" and then
   * refused it, and had to go and ask somebody else to look at the thing they
   * had been assigned. `assigneeId` was added to the complaint's read scope in
   * an earlier fix; this door was left on manage-only.
   *
   * Deliberately NOT the filer, even though they can see the case they raised.
   * Investigative material may concern people other than the person who
   * complained, and being the complainant is not a reason to receive it. They
   * still see that evidence exists, which is what tells them the case is being
   * worked.
   */
  async downloadEvidence(p: Principal, complaintId: string, evidenceId: string): Promise<{ url: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Must be able to see the case at all — this is what keeps the coarse
      // `discipline.file` route gate safe, and what keeps the subject of a case
      // out of its evidence.
      await this.requireVisible(tx, p, complaintId);
      if (!this.canManage(p)) {
        const assigned = await tx.disciplineAssignee.findFirst({
          where: { complaintId, assigneeId: p.userId },
          select: { id: true },
        });
        // 404, not 403: whether a piece of evidence exists on a case you cannot
        // see is itself something you should not learn.
        if (!assigned) throw new NotFoundException("Evidence not found");
      }
      const ev = await tx.disciplineEvidence.findFirst({ where: { id: evidenceId, complaintId } });
      if (!ev) throw new NotFoundException("Evidence not found");
      await this.log(tx, p, "discipline.evidence.read", complaintId, { evidenceId });
      const { url } = await this.storage.presignDownload({ key: ev.fileKey });
      return { url };
    });
  }

  // --- reads ----------------------------------------------------------------

  /** Staff see all complaints; a filer sees only the ones they filed. Keyset-paged. */
  async list(p: Principal, opts: { cursor?: string; limit?: number } = {}): Promise<PageDto<DisciplineComplaintDto>> {
    const limit = pageLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where = await this.visibleComplaintWhere(tx, p);
      const rows = (await tx.disciplineComplaint.findMany({
        where: { ...where, ...seekWhere(cursor) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      })) as ComplaintRow[];
      const page = toPage(rows, limit);
      const complaints = page.items;
      // Audit-log the listing of complaints (evidence on minors is sensitive).
      await this.log(tx, p, "discipline.list", "list", { count: complaints.length, scope: this.canManage(p) ? "all" : "own" });
      if (complaints.length === 0) return { items: [], nextCursor: null };
      // Batch every child + name lookup into ONE query each (was 5 queries per
      // complaint via complaintDto — up to ~1000 for a full 200-row page).
      const ids = complaints.map((c) => c.id);
      const [assignees, evidence, entries] = await Promise.all([
        tx.disciplineAssignee.findMany({ where: { complaintId: { in: ids } }, orderBy: { createdAt: "asc" } }) as Promise<AssigneeRow[]>,
        tx.disciplineEvidence.findMany({ where: { complaintId: { in: ids } }, orderBy: { createdAt: "asc" } }) as Promise<EvidenceRow[]>,
        tx.disciplineEntry.findMany({ where: { complaintId: { in: ids } }, orderBy: { createdAt: "asc" } }) as Promise<EntryRow[]>,
      ]);
      const userIds = [
        ...new Set([
          ...complaints.flatMap((c) => [c.complainantId, c.againstId]),
          ...assignees.map((a) => a.assigneeId),
          ...evidence.map((e) => e.uploadedById),
          ...entries.map((e) => e.authorId),
        ]),
      ];
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      const group = <T extends { complaintId: string }>(rows: T[]): Map<string, T[]> => {
        const m = new Map<string, T[]>();
        for (const r of rows) m.set(r.complaintId, [...(m.get(r.complaintId) ?? []), r]);
        return m;
      };
      const aByC = group(assignees);
      const eByC = group(evidence);
      const enByC = group(entries);
      return {
        items: complaints.map((c) => mapComplaintDto(c, aByC.get(c.id) ?? [], eByC.get(c.id) ?? [], enByC.get(c.id) ?? [], nameOf)),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * Relationship-scoped list of people this caller may file AGAINST, for the UI
   * picker. Managers get the whole school (students OR teachers by role). A
   * non-manager (student/parent) gets only their classmates (STUDENT) or the
   * teachers who teach their classes (TEACHER); a filer with no class
   * relationship (e.g. board/accountant/HR) may still name any teacher — staff,
   * not a minor — but no student. Names only, never sensitive fields.
   */
  async listFileTargets(p: Principal, type: "STUDENT" | "TEACHER"): Promise<IdNameDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (this.canManage(p)) {
        return tx.user.findMany({
          where: { roles: { some: { role: { name: type === "STUDENT" ? "student" : "teacher" } } } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: TARGET_CAP,
        });
      }
      const classIds = await this.relatedClassIds(tx, p);
      if (type === "TEACHER") {
        // No class relationship: allow naming any teacher (non-minor staff).
        if (classIds.length === 0) {
          return tx.user.findMany({
            where: { roles: { some: { role: { name: "teacher" } } } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: TARGET_CAP,
          });
        }
        const ids = await this.teacherIdsOfClasses(tx, classIds);
        if (ids.length === 0) return [];
        return tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
      }
      // STUDENT targets = classmates in the caller's related classes, minus self.
      if (classIds.length === 0) return [];
      // ACTIVE only — a departed pupil is not a classmate any more, and must
      // not appear as a target a report can be filed against.
      const enr = await tx.enrollment.findMany({ where: { classId: { in: classIds }, status: "ACTIVE" }, select: { studentId: true }, distinct: ["studentId"] });
      const ids = enr.map((e: { studentId: string }) => e.studentId).filter((id: string) => id !== p.userId);
      if (ids.length === 0) return [];
      return tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: TARGET_CAP });
    });
  }

  async get(p: Principal, complaintId: string): Promise<DisciplineComplaintDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireVisible(tx, p, complaintId);
      await this.log(tx, p, "discipline.read", complaintId, {});
      return this.complaintDto(tx, complaintId);
    });
  }

  // --- helpers --------------------------------------------------------------

  private requireManage(p: Principal): void {
    if (!this.canManage(p)) throw new ForbiddenException("Staff only");
  }

  /** Classes the caller relates to: their own enrolments + their children's. */
  private async relatedClassIds(tx: TenantTx, p: Principal): Promise<string[]> {
    const ids = new Set<string>();
    const own = await tx.enrollment.findMany({ where: { studentId: p.userId, status: "ACTIVE" }, select: { classId: true } });
    own.forEach((e: { classId: string }) => ids.add(e.classId));
    const children = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    if (children.length > 0) {
      const childEnr = await tx.enrollment.findMany({
        where: { studentId: { in: children.map((c: { studentId: string }) => c.studentId) }, status: "ACTIVE" },
        select: { classId: true },
      });
      childEnr.forEach((e: { classId: string }) => ids.add(e.classId));
    }
    return [...ids];
  }

  /** Every teacher tied to a set of classes: form teacher, subject teacher, supervisor. */
  private async teacherIdsOfClasses(tx: TenantTx, classIds: string[]): Promise<string[]> {
    const ids = new Set<string>();
    const ct = await tx.classTeacher.findMany({ where: { classId: { in: classIds } }, select: { teacherId: true } });
    ct.forEach((t: { teacherId: string }) => ids.add(t.teacherId));
    const cst = await tx.classSubjectTeacher.findMany({ where: { classId: { in: classIds } }, select: { teacherId: true } });
    cst.forEach((t: { teacherId: string }) => ids.add(t.teacherId));
    const sup = await tx.class.findMany({ where: { id: { in: classIds }, supervisorId: { not: null } }, select: { supervisorId: true } });
    sup.forEach((c: { supervisorId: string | null }) => c.supervisorId && ids.add(c.supervisorId));
    return [...ids];
  }

  /** Server-side membership check mirroring listFileTargets (see file()). */
  private async isAllowedTarget(tx: TenantTx, p: Principal, againstId: string, type: "STUDENT" | "TEACHER"): Promise<boolean> {
    const classIds = await this.relatedClassIds(tx, p);
    if (type === "TEACHER") {
      if (classIds.length === 0) {
        const t = await tx.user.findFirst({ where: { id: againstId, roles: { some: { role: { name: "teacher" } } } }, select: { id: true } });
        return Boolean(t);
      }
      return (await this.teacherIdsOfClasses(tx, classIds)).includes(againstId);
    }
    if (classIds.length === 0 || againstId === p.userId) return false;
    const en = await tx.enrollment.findFirst({ where: { status: "ACTIVE", classId: { in: classIds }, studentId: againstId }, select: { id: true } });
    return Boolean(en);
  }
  // requireComplaint(tx, id) — REMOVED. It looked a complaint up by id and
  // applied no scope at all, which is how every mutation door came to accept a
  // case the caller could not see. Use requireVisible(tx, p, id).

  private async complaintDto(tx: TenantTx, id: string): Promise<DisciplineComplaintDto> {
    const c = (await tx.disciplineComplaint.findFirstOrThrow({ where: { id } })) as ComplaintRow;
    const assignees = (await tx.disciplineAssignee.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } })) as AssigneeRow[];
    const evidence = (await tx.disciplineEvidence.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } })) as EvidenceRow[];
    const entries = (await tx.disciplineEntry.findMany({ where: { complaintId: id }, orderBy: { createdAt: "asc" } })) as EntryRow[];
    const ids = [
      ...new Set([
        c.complainantId,
        c.againstId,
        ...assignees.map((a) => a.assigneeId),
        ...evidence.map((e) => e.uploadedById),
        ...entries.map((e) => e.authorId),
      ]),
    ];
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
    return mapComplaintDto(c, assignees, evidence, entries, nameOf);
  }

  private log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.audit.record(
      { actorId: p.userId, action, entity: "discipline", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}

type ComplaintRow = {
  id: string;
  subject: string;
  details: string | null;
  complainantId: string;
  againstId: string;
  againstType: string;
  status: string;
  resolution: string | null;
  createdAt: Date;
};
type AssigneeRow = { id: string; complaintId: string; assigneeId: string; createdAt: Date };
type EvidenceRow = { id: string; complaintId: string; uploadedById: string; fileName: string; createdAt: Date };
type EntryRow = { id: string; complaintId: string; authorId: string; body: string; createdAt: Date };

/**
 * Pure complaint-row → DTO. Child rows (assignees/evidence/entries) and the
 * user-name map are supplied by the caller — fetched once for a single complaint
 * or batched across a page — so listing never fans out into a per-complaint query
 * storm. Names are looked up, never the sensitive complaint body.
 */
function mapComplaintDto(
  c: ComplaintRow,
  assignees: AssigneeRow[],
  evidence: EvidenceRow[],
  entries: EntryRow[],
  nameOf: Map<string, string>,
): DisciplineComplaintDto {
  return {
    id: c.id,
    subject: c.subject,
    details: c.details,
    complainantId: c.complainantId,
    complainantName: nameOf.get(c.complainantId) ?? "",
    againstId: c.againstId,
    againstName: nameOf.get(c.againstId) ?? "",
    againstType: c.againstType,
    status: c.status,
    resolution: c.resolution,
    assignees: assignees.map((a) => ({ id: a.id, assigneeId: a.assigneeId, assigneeName: nameOf.get(a.assigneeId) ?? "" })),
    evidence: evidence.map((e) => ({ id: e.id, uploadedById: e.uploadedById, uploadedByName: nameOf.get(e.uploadedById) ?? "", fileName: e.fileName, createdAt: e.createdAt })),
    entries: entries.map((e) => ({ id: e.id, authorId: e.authorId, authorName: nameOf.get(e.authorId) ?? "", body: e.body, createdAt: e.createdAt })),
    createdAt: c.createdAt,
  };
}
