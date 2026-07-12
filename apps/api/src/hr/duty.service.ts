// =============================================================================
// DutyService — duty rostering for non-timetabled staff
// =============================================================================
// hr.write assigns dated duties (bulk: several staff × several dates in one
// call); assignees are notified (best-effort). A roster is a PLAN, so unassign
// deletes the row — audited. Staff see their own duties (hr.self); hr.read sees
// the whole roster. Tenant-isolated (RLS).
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { DutyAssignmentDto } from "@sms/types";
import { NotificationService } from "../notifications/notification.service";
import { hhmmToMinutes } from "./attendance.util";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const MAX_BULK = 200; // staff × dates guardrail per call

type DutyRow = {
  id: string;
  userId: string;
  date: Date;
  title: string;
  startTime: string;
  endTime: string;
  note: string | null;
  createdAt: Date;
};

@Injectable()
export class DutyService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Assign a duty to one or more staff across one or more dates (bulk). */
  async assign(
    p: Principal,
    input: { userIds: string[]; dates: string[]; title: string; startTime: string; endTime: string; note?: string },
  ): Promise<{ created: number }> {
    const title = (input.title ?? "").trim();
    if (!title) throw new BadRequestException("title is required");
    const start = hhmmToMinutes(input.startTime);
    const end = hhmmToMinutes(input.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new BadRequestException("times must be HH:MM");
    const dates = input.dates.map((d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequestException("dates must be YYYY-MM-DD");
      return new Date(`${d}T00:00:00.000Z`);
    });
    if (input.userIds.length === 0 || dates.length === 0) throw new BadRequestException("pick staff and dates");
    if (input.userIds.length * dates.length > MAX_BULK) {
      throw new BadRequestException(`Too many assignments in one call (max ${MAX_BULK})`);
    }
    const note = (input.note ?? "").trim() || null;
    const created = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const employees = await tx.employee.findMany({
        where: { userId: { in: input.userIds }, status: "ACTIVE" },
        select: { userId: true },
      });
      const active = new Set(employees.map((e) => e.userId));
      const missing = input.userIds.filter((u) => !active.has(u));
      if (missing.length) throw new NotFoundException("Some selected staff have no active employment record");
      const rows = input.userIds.flatMap((userId) =>
        dates.map((date) => ({
          schoolId: p.schoolId,
          userId,
          date,
          title,
          startTime: input.startTime,
          endTime: input.endTime,
          note,
          assignedById: p.userId,
        })),
      );
      await tx.dutyAssignment.createMany({ data: rows });
      await this.audit.record(
        { actorId: p.userId, action: "hr.duty.assign", entity: "duty_assignment", entityId: p.schoolId, schoolId: p.schoolId, metadata: { title, staff: input.userIds.length, dates: dates.length } },
        tx,
      );
      return rows.length;
    });
    // Notify each assignee once (best-effort, outside the tx).
    for (const userId of input.userIds) {
      try {
        await this.notifications.enqueue(this.ctx(p), {
          recipientId: userId,
          type: "ANNOUNCEMENT",
          title: `Duty assigned: ${title}`,
          body: `${input.startTime}–${input.endTime} on ${input.dates.join(", ")}${note ? ` — ${note}` : ""}`,
          data: { kind: "duty", title },
        });
      } catch {
        /* notification is best-effort */
      }
    }
    return { created };
  }

  /** The roster for a date range (hr.read). */
  async list(p: Principal, from: string, to: string): Promise<DutyAssignmentDto[]> {
    const f = new Date(`${from}T00:00:00.000Z`);
    const t = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException("from/to must be YYYY-MM-DD");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.dutyAssignment.findMany({
        where: { date: { gte: f, lte: t } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      });
      const users = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, name: true },
      });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((r) => this.toDto(r, nameById.get(r.userId) ?? "Staff"));
    });
  }

  /** My upcoming duties (staff self-service; from a week back, 30 entries). */
  async mine(p: Principal): Promise<DutyAssignmentDto[]> {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 7);
    from.setUTCHours(0, 0, 0, 0);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.dutyAssignment.findMany({
        where: { userId: p.userId, date: { gte: from } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
        take: 30,
      });
      return rows.map((r) => this.toDto(r, null));
    });
  }

  /** Unassign (a roster is a plan — the delete is audited). */
  async remove(p: Principal, id: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.dutyAssignment.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Duty assignment not found");
      await tx.dutyAssignment.delete({ where: { id } });
      await this.audit.record(
        { actorId: p.userId, action: "hr.duty.unassign", entity: "duty_assignment", entityId: id, schoolId: p.schoolId, metadata: { userId: row.userId, title: row.title } },
        tx,
      );
      return { deleted: true };
    });
  }

  private toDto(r: DutyRow, userName: string | null): DutyAssignmentDto {
    return {
      id: r.id,
      userId: r.userId,
      userName,
      date: r.date,
      title: r.title,
      startTime: r.startTime,
      endTime: r.endTime,
      note: r.note,
      createdAt: r.createdAt,
    };
  }
}
