// =============================================================================
// LeaveService — leave types, balances, and applications
// =============================================================================
// A leave application is raised by ANY staff member and routed through the
// multi-stage workflow engine (head → HR → principal). On FINAL approval a
// finalized-hook (registered with WorkflowHooksService, run in-tx) flips the
// leave_request to APPROVED and decrements the staff member's balance; a rejection
// flips it to REJECTED. The hook is idempotent — it only acts on a PENDING row, so
// a board veto on an already-applied leave is a no-op (handled manually).
// Tenant-isolated (RLS); self-service reads are scoped to the caller.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import {
  STAFF_REQUEST_CHAIN,
  type LeaveBalanceDto,
  type LeaveRequestDto,
  type LeaveTypeDto,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService, type FinalizedRequest } from "../workflow/workflow-hooks.service";

interface LeavePayload {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string | null;
}

@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    private readonly hooks: WorkflowHooksService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Register the in-tx reactor for finalized LEAVE requests. */
  onModuleInit(): void {
    this.hooks.onFinalized((tx, req) => this.applyFinalizedLeave(tx, req));
  }

  // --- leave types -----------------------------------------------------------
  async listLeaveTypes(p: Principal): Promise<LeaveTypeDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const types = await tx.leaveType.findMany({ orderBy: { name: "asc" } });
      return types.map((t) => ({ id: t.id, name: t.name, daysPerYear: t.daysPerYear, active: t.active }));
    });
  }

  async createLeaveType(
    p: Principal,
    input: { name: string; daysPerYear: number; active?: boolean },
  ): Promise<LeaveTypeDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const t = await tx.leaveType.create({
        data: { schoolId: p.schoolId, name: input.name, daysPerYear: input.daysPerYear, active: input.active ?? true },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.leave.type.create", entity: "leave_type", entityId: t.id, schoolId: p.schoolId },
        tx,
      );
      return { id: t.id, name: t.name, daysPerYear: t.daysPerYear, active: t.active };
    });
  }

  // --- balances --------------------------------------------------------------
  async myBalances(p: Principal): Promise<LeaveBalanceDto[]> {
    return this.balancesFor(p, p.userId);
  }

  /** Balances for a user in the current year, one row per ACTIVE leave type
   *  (synthesised at full entitlement when no row exists yet). */
  async balancesFor(p: Principal, userId: string): Promise<LeaveBalanceDto[]> {
    const year = new Date().getUTCFullYear();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const types = await tx.leaveType.findMany({ where: { active: true }, orderBy: { name: "asc" } });
      const rows = await tx.leaveBalance.findMany({ where: { userId, year } });
      const byType = new Map(rows.map((r) => [r.leaveTypeId, r]));
      return types.map((t) => {
        const row = byType.get(t.id);
        const entitled = row?.entitledDays ?? t.daysPerYear;
        const used = row?.usedDays ?? 0;
        return {
          id: row?.id ?? `virtual-${t.id}`,
          leaveTypeId: t.id,
          leaveTypeName: t.name,
          year,
          entitledDays: entitled,
          usedDays: used,
          remainingDays: entitled - used,
        };
      });
    });
  }

  // --- applications ----------------------------------------------------------
  /** Raise a leave application → creates the staged WorkflowRequest and submits it. */
  async requestLeave(p: Principal, input: LeavePayload): Promise<LeaveRequestDto> {
    if (input.days <= 0) throw new BadRequestException("days must be positive");
    if (new Date(input.endDate) < new Date(input.startDate)) {
      throw new BadRequestException("endDate must be on/after startDate");
    }
    // Validate the leave type exists in this tenant.
    const type = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.leaveType.findFirst({ where: { id: input.leaveTypeId } }),
    );
    if (!type) throw new NotFoundException("Leave type not found");

    // 1) staged workflow request (head → HR → principal), 2) the leave row, 3) submit.
    const wf = await this.workflow.createRequest(p, {
      type: "LEAVE",
      title: `Leave: ${type.name}`,
      payload: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days: input.days, reason: input.reason ?? null },
      stages: STAFF_REQUEST_CHAIN,
    });
    const created = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const lr = await tx.leaveRequest.create({
        data: {
          schoolId: p.schoolId,
          userId: p.userId,
          leaveTypeId: input.leaveTypeId,
          startDate: new Date(input.startDate),
          endDate: new Date(input.endDate),
          days: input.days,
          reason: input.reason ?? null,
          status: "PENDING",
          workflowRequestId: wf.id,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "hr.leave.request", entity: "leave_request", entityId: lr.id, schoolId: p.schoolId, metadata: { workflowRequestId: wf.id } },
        tx,
      );
      return lr;
    });
    await this.workflow.submit(p, wf.id);
    return this.decorateRequest(created, type.name, null);
  }

  async myRequests(p: Principal): Promise<LeaveRequestDto[]> {
    return this.listRequestsWhere(p, { userId: p.userId });
  }

  /** HR/managers see all leave requests in the tenant. */
  async listRequests(p: Principal): Promise<LeaveRequestDto[]> {
    return this.listRequestsWhere(p, {});
  }

  /** Approved leave overlapping [from, to] — the "who's out" coverage view. */
  async calendar(p: Principal, fromISO?: string, toISO?: string): Promise<LeaveRequestDto[]> {
    const from = fromISO ? new Date(fromISO) : new Date();
    const to = toISO ? new Date(toISO) : new Date(Date.now() + 60 * 86_400_000);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.leaveRequest.findMany({
        where: { status: "APPROVED", startDate: { lte: to }, endDate: { gte: from } },
        orderBy: { startDate: "asc" },
      });
      const typeIds = [...new Set(rows.map((r) => r.leaveTypeId))];
      const userIds = [...new Set(rows.map((r) => r.userId))];
      const types = await tx.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } });
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      const userName = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((r) => this.decorateRequest(r, typeName.get(r.leaveTypeId) ?? null, userName.get(r.userId) ?? null));
    });
  }

  private async listRequestsWhere(p: Principal, where: { userId?: string }): Promise<LeaveRequestDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.leaveRequest.findMany({ where, orderBy: { createdAt: "desc" } });
      const typeIds = [...new Set(rows.map((r) => r.leaveTypeId))];
      const userIds = [...new Set(rows.map((r) => r.userId))];
      const types = await tx.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } });
      const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      const userName = new Map(users.map((u) => [u.id, u.name]));
      return rows.map((r) => this.decorateRequest(r, typeName.get(r.leaveTypeId) ?? null, userName.get(r.userId) ?? null));
    });
  }

  private decorateRequest(
    r: { id: string; leaveTypeId: string; startDate: Date; endDate: Date; days: number; reason: string | null; status: string; workflowRequestId: string | null; createdAt: Date },
    leaveTypeName: string | null,
    userName: string | null,
  ): LeaveRequestDto {
    return {
      id: r.id,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName,
      startDate: r.startDate,
      endDate: r.endDate,
      days: r.days,
      reason: r.reason,
      status: r.status,
      workflowRequestId: r.workflowRequestId,
      user: userName ? { name: userName } : null,
      createdAt: r.createdAt,
    };
  }

  // --- the in-tx reactor (registered onModuleInit) ---------------------------
  private async applyFinalizedLeave(tx: TenantTx, req: FinalizedRequest): Promise<void> {
    if (req.type !== "LEAVE") return;
    const lr = await tx.leaveRequest.findFirst({ where: { workflowRequestId: req.id } });
    if (!lr || lr.status !== "PENDING") return; // idempotent: only act once, from PENDING

    if (req.state === "REJECTED") {
      await tx.leaveRequest.update({ where: { id: lr.id }, data: { status: "REJECTED" } });
      return;
    }
    // APPROVED → mark + decrement the year's balance (synthesise the row if absent).
    await tx.leaveRequest.update({ where: { id: lr.id }, data: { status: "APPROVED" } });
    const year = lr.startDate.getUTCFullYear();
    const type = await tx.leaveType.findFirst({ where: { id: lr.leaveTypeId } });
    const entitled = type?.daysPerYear ?? 0;
    const existing = await tx.leaveBalance.findFirst({
      where: { userId: lr.userId, leaveTypeId: lr.leaveTypeId, year },
    });
    if (existing) {
      await tx.leaveBalance.update({ where: { id: existing.id }, data: { usedDays: existing.usedDays + lr.days } });
    } else {
      await tx.leaveBalance.create({
        data: { schoolId: req.schoolId, userId: lr.userId, leaveTypeId: lr.leaveTypeId, year, entitledDays: entitled, usedDays: lr.days },
      });
    }
  }
}
