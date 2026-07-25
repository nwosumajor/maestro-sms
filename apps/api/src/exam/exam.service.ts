// =============================================================================
// ExamService — physical exam logistics: sittings, seating, invigilation
// =============================================================================
// Staff (exam.manage) schedule a sitting in a hall, auto-seat students, and
// roster invigilators. Students/parents see the student's own seat + hall +
// time; staff see the sittings they invigilate. Seating is idempotent-ish:
// re-seating replaces the plan. Notifications go to invigilators on assignment.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ExamScheduleDto, ExamSittingDto, ExamSeatDto, MyExamDto, InvigilationDto } from "@sms/types";
import { EXAM_SCHEDULE_CHAIN } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";

@Injectable()
export class ExamService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly workflow: WorkflowService,
    hooks: WorkflowHooksService,
  ) {
    // Maker-checker reactor: when the exam-schedule approval finalizes, publish
    // every linked CBT exam (APPROVED) or return them to draft (REJECTED). Runs
    // in the workflow transition's tenant tx; idempotent via status-guarded
    // updateMany, so a replay or a board veto re-firing is a no-op.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "EXAM_SCHEDULE_APPROVAL") return;
      const scheduleId = (req.payload as { scheduleId?: string } | null)?.scheduleId;
      if (!scheduleId) return;
      const approved = req.state === "APPROVED";
      const moved = await tx.examSchedule.updateMany({
        where: { id: scheduleId, status: "PENDING_REVIEW" },
        data: { status: approved ? "APPROVED" : "DRAFT" },
      });
      if (moved.count === 0) return; // already handled / not claimed
      const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
      const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
      if (examIds.length > 0) {
        await tx.cbtExam.updateMany({
          where: { id: { in: examIds }, status: "PENDING_APPROVAL" },
          data: { status: approved ? "PUBLISHED" : "DRAFT" },
        });
      }
      await this.audit.record(
        {
          actorId: req.initiatorId,
          action: approved ? "exam.schedule.approved" : "exam.schedule.rejected",
          entity: "exam_schedule",
          entityId: scheduleId,
          schoolId: req.schoolId,
          metadata: { requestId: req.id, exams: examIds.length },
        },
        tx,
      );
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // --- staff: sittings --------------------------------------------------------

  async createSitting(
    p: Principal,
    input: { title: string; subject?: string; date: string; startsAt: string; endsAt: string; hall: string; capacity?: number; note?: string; scheduleId?: string | null; cbtExamId?: string | null },
  ): Promise<ExamSittingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Validate the schedule + CBT exam are in-tenant, and that a CBT-backed
      // sitting only attaches a DRAFT exam (it gets published via the schedule
      // approval, never already-live).
      let cbtStatus: string | null = null;
      if (input.scheduleId) {
        const sched = await tx.examSchedule.findFirst({ where: { id: input.scheduleId, status: "DRAFT" }, select: { id: true } });
        if (!sched) throw new BadRequestException("Schedule not found or already submitted for approval");
      }
      if (input.cbtExamId) {
        const exam = await tx.cbtExam.findFirst({ where: { id: input.cbtExamId }, select: { id: true, status: true } });
        if (!exam) throw new NotFoundException("CBT exam not found");
        if (exam.status !== "DRAFT") throw new ConflictException("Only a DRAFT CBT exam can be attached to a sitting");
        // One exam ↔ one sitting: refuse if it's already linked.
        const linked = await tx.examSitting.findFirst({ where: { cbtExamId: input.cbtExamId }, select: { id: true } });
        if (linked) throw new ConflictException("That CBT exam is already attached to a sitting");
        cbtStatus = exam.status;
      }
      const row = (await tx.examSitting.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          subject: input.subject ?? null,
          date: new Date(`${input.date}T00:00:00.000Z`),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          hall: input.hall,
          capacity: input.capacity ?? 0,
          note: input.note ?? null,
          scheduleId: input.scheduleId ?? null,
          cbtExamId: input.cbtExamId ?? null,
          createdById: p.userId,
        },
      })) as SittingRow;
      await this.audit.record(
        { actorId: p.userId, action: "exam.sitting.create", entity: "exam_sitting", entityId: row.id, schoolId: p.schoolId },
        tx,
      );
      return this.toSittingDto(row, 0, 0, { status: cbtStatus, released: false, started: 0, submitted: 0 });
    });
  }

  async listSittings(p: Principal): Promise<ExamSittingDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.examSitting.findMany({ orderBy: { date: "desc" }, take: 200 })) as SittingRow[];
      const ids = rows.map((r) => r.id);
      const examIds = [...new Set(rows.map((r) => r.cbtExamId).filter((x): x is string => !!x))];
      // All the per-sitting facts are gathered in a FIXED number of batched
      // queries (seat/invigilator counts, the CBT exams' status/release, and the
      // sitting tallies grouped by exam) — never a query per row.
      const [seats, invs, exams, tallies] = await Promise.all([
        this.countBy(tx, "examSeat", "sittingId", ids),
        this.countBy(tx, "examInvigilator", "sittingId", ids),
        examIds.length
          ? (tx.cbtExam.findMany({ where: { id: { in: examIds } }, select: { id: true, status: true, releasedAt: true } }) as Promise<Array<{ id: string; status: string; releasedAt: Date | null }>>)
          : Promise.resolve([] as Array<{ id: string; status: string; releasedAt: Date | null }>),
        examIds.length
          ? (tx.cbtSitting.groupBy({ by: ["examId", "status"], where: { examId: { in: examIds } }, _count: { _all: true } } as never) as unknown as Promise<Array<{ examId: string; status: string; _count: { _all: number } }>>)
          : Promise.resolve([] as Array<{ examId: string; status: string; _count: { _all: number } }>),
      ]);
      const examById = new Map(exams.map((e) => [e.id, e]));
      const started = new Map<string, number>();
      const submitted = new Map<string, number>();
      for (const t of tallies) {
        started.set(t.examId, (started.get(t.examId) ?? 0) + t._count._all);
        if (t.status === "SUBMITTED" || t.status === "EXPIRED") submitted.set(t.examId, (submitted.get(t.examId) ?? 0) + t._count._all);
      }
      return rows.map((r) => {
        const e = r.cbtExamId ? examById.get(r.cbtExamId) : undefined;
        return this.toSittingDto(r, seats.get(r.id) ?? 0, invs.get(r.id) ?? 0, {
          status: e?.status ?? null,
          released: !!e?.releasedAt,
          started: r.cbtExamId ? started.get(r.cbtExamId) ?? 0 : 0,
          submitted: r.cbtExamId ? submitted.get(r.cbtExamId) ?? 0 : 0,
        });
      });
    });
  }

  async deleteSitting(p: Principal, id: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.examSitting.deleteMany({ where: { id } }); // cascades seats + invigilators
      if (res.count === 0) throw new NotFoundException("Sitting not found");
      await this.audit.record(
        { actorId: p.userId, action: "exam.sitting.delete", entity: "exam_sitting", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { deleted: true };
    });
  }

  // --- schedules (maker-checker) + day-of release -----------------------------

  async createSchedule(p: Principal, input: { title: string; termId?: string | null }): Promise<ExamScheduleDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.examSchedule.create({
        data: { schoolId: p.schoolId, title: input.title, termId: input.termId ?? null, createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "exam.schedule.create", entity: "exam_schedule", entityId: row.id, schoolId: p.schoolId },
        tx,
      );
      return { id: row.id, title: row.title, termId: row.termId, status: row.status, createdAt: row.createdAt.toISOString(), sittingCount: 0, cbtCount: 0 };
    });
  }

  async listSchedules(p: Principal): Promise<ExamScheduleDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.examSchedule.findMany({ orderBy: { createdAt: "desc" }, take: 100 })) as Array<{ id: string; title: string; termId: string | null; status: string; createdAt: Date }>;
      if (rows.length === 0) return [];
      // ONE grouped query for sitting counts (+ how many are CBT-backed) across
      // every schedule — no per-schedule fan-out.
      const ids = rows.map((r) => r.id);
      const sittings = (await tx.examSitting.findMany({ where: { scheduleId: { in: ids } }, select: { scheduleId: true, cbtExamId: true } })) as Array<{ scheduleId: string | null; cbtExamId: string | null }>;
      const total = new Map<string, number>();
      const cbt = new Map<string, number>();
      for (const s of sittings) {
        if (!s.scheduleId) continue;
        total.set(s.scheduleId, (total.get(s.scheduleId) ?? 0) + 1);
        if (s.cbtExamId) cbt.set(s.scheduleId, (cbt.get(s.scheduleId) ?? 0) + 1);
      }
      return rows.map((r) => ({ id: r.id, title: r.title, termId: r.termId, status: r.status, createdAt: r.createdAt.toISOString(), sittingCount: total.get(r.id) ?? 0, cbtCount: cbt.get(r.id) ?? 0 }));
    });
  }

  /** Maker-checker: submit a whole schedule for head-teacher → principal approval.
   *  Claims the schedule (DRAFT → PENDING_REVIEW) and parks its CBT exams
   *  PENDING_APPROVAL; the finalized reactor publishes them on approval. */
  async requestScheduleApproval(p: Principal, scheduleId: string): Promise<{ pendingApproval: true; requestId: string }> {
    const claimed = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sched = await tx.examSchedule.findFirst({ where: { id: scheduleId }, select: { id: true, title: true } });
      if (!sched) throw new NotFoundException("Schedule not found");
      const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
      if (sittings.length === 0) throw new ConflictException("Add at least one sitting before submitting the schedule");
      const res = await tx.examSchedule.updateMany({ where: { id: scheduleId, status: "DRAFT" }, data: { status: "PENDING_REVIEW" } });
      if (res.count === 0) throw new ConflictException("Only a draft schedule can be submitted for approval");
      const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
      if (examIds.length > 0) {
        await tx.cbtExam.updateMany({ where: { id: { in: examIds }, status: "DRAFT" }, data: { status: "PENDING_APPROVAL" } });
      }
      await this.audit.record(
        { actorId: p.userId, action: "exam.schedule.submit", entity: "exam_schedule", entityId: scheduleId, schoolId: p.schoolId, metadata: { exams: examIds.length } },
        tx,
      );
      return { title: sched.title };
    });
    // Raise + submit the two-stage approval; release the claim if it fails so the
    // schedule can never strand in PENDING_REVIEW without a reviewer.
    try {
      const req = (await this.workflow.createRequest(p, {
        type: "EXAM_SCHEDULE_APPROVAL",
        title: `Approve exam schedule: ${claimed.title}`,
        payload: { scheduleId },
        stages: [...EXAM_SCHEDULE_CHAIN],
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true, requestId: req.id };
    } catch (err) {
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        await tx.examSchedule.updateMany({ where: { id: scheduleId, status: "PENDING_REVIEW" }, data: { status: "DRAFT" } });
        const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
        const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
        if (examIds.length > 0) await tx.cbtExam.updateMany({ where: { id: { in: examIds }, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
      });
      throw err;
    }
  }

  /** Day-of RELEASE (open) an approved CBT-backed sitting for students to sit.
   *  A single authorized action (exam.release: principal / head teacher /
   *  school admin). The exam must be PUBLISHED (schedule approved) and its date
   *  today; releasing sets releasedAt, which startSitting requires. */
  async releaseSitting(p: Principal, sittingId: string): Promise<{ released: true; examId: string }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = (await tx.examSitting.findFirst({ where: { id: sittingId }, select: { cbtExamId: true, date: true } })) as { cbtExamId: string | null; date: Date } | null;
      if (!sitting) throw new NotFoundException("Sitting not found");
      if (!sitting.cbtExamId) throw new BadRequestException("This is a paper sitting — nothing to release online");
      // Release is meant for the exam day: refuse before the scheduled date.
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      if (new Date(sitting.date) > today) throw new ConflictException("The exam can only be released on or after its scheduled date");
      const res = await tx.cbtExam.updateMany({
        where: { id: sitting.cbtExamId, status: "PUBLISHED", releasedAt: null },
        data: { releasedAt: new Date(), releasedById: p.userId },
      });
      if (res.count === 0) throw new ConflictException("The exam is not approved for release, or has already been released");
      await this.audit.record(
        { actorId: p.userId, action: "exam.release", entity: "cbt", entityId: sitting.cbtExamId, schoolId: p.schoolId, metadata: { sittingId } },
        tx,
      );
      return { released: true as const, examId: sitting.cbtExamId };
    });
  }

  // --- staff: seating ---------------------------------------------------------

  /** Replace the sitting's seating plan with the given students, seat 1..N.
   *  Respects the sitting capacity when set. */
  async seat(p: Principal, sittingId: string, studentIds: string[]): Promise<ExamSeatDto[]> {
    const uniq = [...new Set(studentIds)];
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.examSitting.findFirst({ where: { id: sittingId }, select: { id: true, capacity: true } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      if (sitting.capacity > 0 && uniq.length > sitting.capacity) {
        throw new ConflictException(`Only ${sitting.capacity} seats in this hall (${uniq.length} students given)`);
      }
      await tx.examSeat.deleteMany({ where: { sittingId } });
      await tx.examSeat.createMany({
        data: uniq.map((studentId, i) => ({ schoolId: p.schoolId, sittingId, studentId, seatNo: i + 1 })),
      });
      await this.audit.record(
        { actorId: p.userId, action: "exam.seat.assign", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { seats: uniq.length } },
        tx,
      );
      return this.seatPlan(tx, sittingId);
    });
  }

  /** Auto-seat every student enrolled in a class into the sitting. */
  async seatClass(p: Principal, sittingId: string, classId: string): Promise<ExamSeatDto[]> {
    const studentIds = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const enr = await tx.enrollment.findMany({ where: { classId }, select: { studentId: true } });
      return enr.map((e: { studentId: string }) => e.studentId);
    });
    if (studentIds.length === 0) throw new BadRequestException("That class has no enrolled students");
    return this.seat(p, sittingId, studentIds);
  }

  async getSeatPlan(p: Principal, sittingId: string): Promise<ExamSeatDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.seatPlan(tx, sittingId));
  }

  private async seatPlan(tx: TenantTx, sittingId: string): Promise<ExamSeatDto[]> {
    const seats = await tx.examSeat.findMany({ where: { sittingId }, orderBy: { seatNo: "asc" } });
    const names = await this.userNames(tx, seats.map((s: { studentId: string }) => s.studentId));
    return seats.map((s: { studentId: string; seatNo: number }) => ({ studentId: s.studentId, studentName: names.get(s.studentId) ?? "", seatNo: s.seatNo }));
  }

  // --- staff: invigilation ----------------------------------------------------

  async assignInvigilator(p: Principal, sittingId: string, staffId: string, lead: boolean): Promise<InvigilationDto> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.examSitting.findFirst({ where: { id: sittingId }, select: { id: true, title: true, date: true, startsAt: true, hall: true } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      const staff = await tx.user.findFirst({ where: { id: staffId }, select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } } });
      if (!staff) throw new NotFoundException("Staff not found");
      const isStaff = staff.roles.some((r: { role: { name: string } }) => r.role.name !== "student" && r.role.name !== "parent");
      if (!isStaff) throw new BadRequestException("Only a staff member can invigilate");
      // Assignment rows are INSERT/DELETE only (rls/87 grants no UPDATE — a
      // roster change is a remove + re-add, so the history reads honestly).
      // Re-assigning the same staffer replaces the row rather than updating it.
      await tx.examInvigilator.deleteMany({ where: { sittingId, staffId } });
      await tx.examInvigilator.create({ data: { schoolId: p.schoolId, sittingId, staffId, lead } });
      await this.audit.record(
        { actorId: p.userId, action: "exam.invigilator.assign", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { staffId, lead } },
        tx,
      );
      return { staff, sitting };
    });
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: staffId,
        type: "GENERIC",
        title: "Invigilation duty assigned",
        body: `You're invigilating ${outcome.sitting.title} on ${this.dateOnly(outcome.sitting.date)} at ${outcome.sitting.startsAt} (${outcome.sitting.hall})${lead ? " — as lead" : ""}.`,
        data: { sittingId },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return { sittingId, staffId, staffName: outcome.staff.name, lead };
  }

  async removeInvigilator(p: Principal, sittingId: string, staffId: string): Promise<{ removed: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.examInvigilator.deleteMany({ where: { sittingId, staffId } });
      if (res.count === 0) throw new NotFoundException("Not found");
      await this.audit.record(
        { actorId: p.userId, action: "exam.invigilator.remove", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { staffId } },
        tx,
      );
      return { removed: true };
    });
  }

  async getInvigilators(p: Principal, sittingId: string): Promise<InvigilationDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.examInvigilator.findMany({ where: { sittingId } });
      const names = await this.userNames(tx, rows.map((r: { staffId: string }) => r.staffId));
      return rows.map((r: { staffId: string; lead: boolean }) => ({ sittingId, staffId: r.staffId, staffName: names.get(r.staffId) ?? "", lead: r.lead }));
    });
  }

  // --- student / parent: my exams ---------------------------------------------

  /** Upcoming sittings where the caller (or their child) has a seat. */
  async myExams(p: Principal): Promise<MyExamDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const studentIds = new Set<string>();
      if (p.roles.includes("student")) studentIds.add(p.userId);
      const kids = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
      kids.forEach((k: { studentId: string }) => studentIds.add(k.studentId));
      if (studentIds.size === 0) return [];
      const seats = await tx.examSeat.findMany({
        where: { studentId: { in: [...studentIds] }, sitting: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } } },
        include: { sitting: { select: { title: true, subject: true, date: true, startsAt: true, endsAt: true, hall: true } } },
      });
      const names = await this.userNames(tx, seats.map((s: { studentId: string }) => s.studentId));
      return seats
        .map((s: SeatWithSitting) => ({
          studentId: s.studentId,
          studentName: names.get(s.studentId) ?? "",
          title: s.sitting.title,
          subject: s.sitting.subject,
          date: this.dateOnly(s.sitting.date),
          startsAt: s.sitting.startsAt,
          endsAt: s.sitting.endsAt,
          hall: s.sitting.hall,
          seatNo: s.seatNo,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt));
    });
  }

  /** Staff: the sittings the caller is rostered to invigilate. */
  async myInvigilations(p: Principal): Promise<MyExamDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.examInvigilator.findMany({
        where: { staffId: p.userId, sitting: { date: { gte: new Date(new Date().toISOString().slice(0, 10)) } } },
        include: { sitting: { select: { title: true, subject: true, date: true, startsAt: true, endsAt: true, hall: true } } },
      });
      return rows
        .map((r: { lead: boolean; sitting: { title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string } }) => ({
          studentId: "",
          studentName: r.lead ? "Lead invigilator" : "Invigilator",
          title: r.sitting.title,
          subject: r.sitting.subject,
          date: this.dateOnly(r.sitting.date),
          startsAt: r.sitting.startsAt,
          endsAt: r.sitting.endsAt,
          hall: r.sitting.hall,
          seatNo: 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt));
    });
  }

  // --- helpers ----------------------------------------------------------------

  private async countBy(tx: TenantTx, model: "examSeat" | "examInvigilator", field: "sittingId", ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const grouped = await (tx as unknown as Record<string, { groupBy: (a: unknown) => Promise<{ sittingId: string; _count: { _all: number } }[]> }>)[model].groupBy({
      by: [field],
      where: { [field]: { in: ids } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.sittingId, g._count._all]));
  }

  private async userNames(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map<string, string>(users.map((u: { id: string; name: string }) => [u.id, u.name] as const));
  }

  private toSittingDto(
    s: SittingRow,
    seated: number,
    invigilators: number,
    cbt: { status: string | null; released: boolean; started: number; submitted: number },
  ): ExamSittingDto {
    return {
      id: s.id,
      title: s.title,
      subject: s.subject,
      date: this.dateOnly(s.date),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      hall: s.hall,
      capacity: s.capacity,
      note: s.note,
      seated,
      invigilators,
      scheduleId: s.scheduleId,
      cbtExamId: s.cbtExamId,
      cbtStatus: cbt.status,
      released: cbt.released,
      started: cbt.started,
      submitted: cbt.submitted,
    };
  }
}

type SittingRow = { id: string; title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string; capacity: number; note: string | null; scheduleId: string | null; cbtExamId: string | null };
type SeatWithSitting = { studentId: string; seatNo: number; sitting: { title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string } };
