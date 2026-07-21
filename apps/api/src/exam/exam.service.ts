// =============================================================================
// ExamService — physical exam logistics: sittings, seating, invigilation
// =============================================================================
// Staff (exam.manage) schedule a sitting in a hall, auto-seat students, and
// roster invigilators. Students/parents see the student's own seat + hall +
// time; staff see the sittings they invigilate. Seating is idempotent-ish:
// re-seating replaces the plan. Notifications go to invigilators on assignment.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ExamSittingDto, ExamSeatDto, MyExamDto, InvigilationDto } from "@sms/types";
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

@Injectable()
export class ExamService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // --- staff: sittings --------------------------------------------------------

  async createSitting(
    p: Principal,
    input: { title: string; subject?: string; date: string; startsAt: string; endsAt: string; hall: string; capacity?: number; note?: string },
  ): Promise<ExamSittingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.examSitting.create({
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
          createdById: p.userId,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "exam.sitting.create", entity: "exam_sitting", entityId: row.id, schoolId: p.schoolId },
        tx,
      );
      return this.toSittingDto(row, 0, 0);
    });
  }

  async listSittings(p: Principal): Promise<ExamSittingDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.examSitting.findMany({ orderBy: { date: "desc" }, take: 200 });
      const ids = rows.map((r: { id: string }) => r.id);
      const [seats, invs] = await Promise.all([
        this.countBy(tx, "examSeat", "sittingId", ids),
        this.countBy(tx, "examInvigilator", "sittingId", ids),
      ]);
      return rows.map((r: SittingRow) => this.toSittingDto(r, seats.get(r.id) ?? 0, invs.get(r.id) ?? 0));
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

  private toSittingDto(s: SittingRow, seated: number, invigilators: number): ExamSittingDto {
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
    };
  }
}

type SittingRow = { id: string; title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string; capacity: number; note: string | null };
type SeatWithSitting = { studentId: string; seatNo: number; sitting: { title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string } };
