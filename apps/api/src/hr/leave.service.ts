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
  LIST_CAP,
  SEARCH_CAP,
  LEAVE_PAGE_SIZE,
  STAFF_REQUEST_CHAIN,
  type LeaveBalanceDto,
  type LeaveRequestDto,
  type LeavePageDto,
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
import { dateWindow } from "../common/status-filter";

interface LeavePayload {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string | null;
  attachmentDocId?: string | null;
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
    // Validate the leave type exists in this tenant; and if an attachment is given,
    // verify it is a document the CALLER uploaded (in-tenant, owned) — so a
    // request can't reference a foreign/arbitrary document id.
    const type = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (input.attachmentDocId) {
        const doc = await tx.document.findFirst({
          where: { id: input.attachmentDocId, uploadedById: p.userId },
          select: { id: true },
        });
        if (!doc) throw new BadRequestException("Attachment must be a document you uploaded");
      }
      return tx.leaveType.findFirst({ where: { id: input.leaveTypeId } });
    });
    if (!type) throw new NotFoundException("Leave type not found");

    // WHAT THE APPROVER WILL ACTUALLY SEE.
    //
    // The workflow inbox renders ONE field from the payload — `summary`, a
    // string a service wrote — and never the raw payload, deliberately, because
    // payloads carry ids and a future type could put anything in there. Nothing
    // here wrote one, so a three-stage chain (head -> HR manager -> principal)
    // was asked to approve a request titled "Leave: Annual" and nothing else:
    // not the dates, not how many days, not whether the person has them.
    //
    // Neither the raise nor the finalized hook checks the balance — the control
    // IS the human — so the human has to be able to see it.
    const year = new Date(input.startDate).getUTCFullYear();
    const balance = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      tx.leaveBalance.findFirst({
        where: { userId: p.userId, leaveTypeId: input.leaveTypeId, year },
        select: { usedDays: true, entitledDays: true },
      }),
    );
    const used = balance?.usedDays ?? 0;
    const entitled = balance?.entitledDays ?? type.daysPerYear ?? 0;
    const after = used + input.days;
    const summary =
      `${input.days} day${input.days === 1 ? "" : "s"} · ${input.startDate.slice(0, 10)} → ${input.endDate.slice(0, 10)} · ` +
      `${used} of ${entitled} used this year, ${after} if approved` +
      // Named rather than left for the approver to work out, because it is the
      // one fact that should change a decision.
      (entitled > 0 && after > entitled ? ` — OVER their ${entitled}-day entitlement` : "");

    // 1) staged workflow request (head → HR → principal), 2) the leave row, 3) submit.
    const wf = await this.workflow.createRequest(p, {
      type: "LEAVE",
      title: `Leave: ${type.name}`,
      payload: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days: input.days, reason: input.reason ?? null, summary },
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
          attachmentDocId: input.attachmentDocId ?? null,
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

  /** Approved leave overlapping [from, to] — the "who's out" coverage view. */
  async calendar(p: Principal, fromISO?: string, toISO?: string): Promise<LeaveRequestDto[]> {
    // Unguarded, `new Date("abc")` here was a 500 — the probe that found the
    // other six missed this one only because it ran as a principal, who does
    // not hold hr.leave.manage. A permission is not a validator.
    const asked = dateWindow(fromISO, toISO);
    const from = asked.from ?? new Date();
    const to = asked.to ?? new Date(Date.now() + 60 * 86_400_000);
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

  /**
   * One page of the school-wide leave register — filtered, searchable, paged.
   *
   * It used to be the 500 most recent, unfiltered, on the reasoning that an
   * approver only needs the current page. But this list is also the RECORD: it
   * is what a school reads to answer "was she on approved leave that week", and
   * that question is asked about last year as often as this one. At 800
   * requests, 300 could not be reached at all.
   *
   * `q` matches the STAFF MEMBER, because that is how the question arrives —
   * "show me Mrs Adeyemi's leave", never a request id. Names live on `user`, so
   * they resolve to ids first (bounded by SEARCH_CAP) and the register is
   * filtered on those.
   *
   * `from`/`to` are an OVERLAP, the same rule the coverage calendar uses: a
   * request from 28 March to 2 April is leave taken in March, and a filter that
   * missed it would quietly answer "nobody was off".
   */
  async listRegister(
    p: Principal,
    opts: { status?: string; q?: string; from?: string; to?: string; page?: number } = {},
  ): Promise<LeavePageDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const q = opts.q?.trim();
      let userIds: string[] | null = null;
      if (q) {
        const people = (await tx.user.findMany({
          where: { name: { contains: q, mode: "insensitive" } },
          select: { id: true },
          take: SEARCH_CAP,
        })) as Array<{ id: string }>;
        userIds = people.map((u) => u.id);
        // Nobody of that name — an empty page, not the whole register.
        if (userIds.length === 0) {
          return { items: [], total: 0, page: Math.max(1, Math.floor(opts.page ?? 1)), pageSize: LEAVE_PAGE_SIZE };
        }
      }
      const listWindow = dateWindow(opts.from, opts.to);
      const where = {
        ...(opts.status ? { status: opts.status } : {}),
        ...(userIds ? { userId: { in: userIds } } : {}),
        // Overlap, not containment — see above.
        ...(listWindow.to ? { startDate: { lte: listWindow.to } } : {}),
        ...(listWindow.from ? { endDate: { gte: listWindow.from } } : {}),
      };
      const page = Math.max(1, Math.floor(opts.page ?? 1));
      const [rows, total] = await Promise.all([
        tx.leaveRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * LEAVE_PAGE_SIZE,
          take: LEAVE_PAGE_SIZE,
        }),
        tx.leaveRequest.count({ where }),
      ]);
      return { items: await this.decorateMany(tx, rows), total, page, pageSize: LEAVE_PAGE_SIZE };
    });
  }

  /** Resolve type and staff names for a batch of rows — two queries whatever the
   *  page size, never one per row. */
  private async decorateMany(
    tx: TenantTx,
    rows: Array<Parameters<LeaveService["decorateRequest"]>[0] & { userId: string }>,
  ): Promise<LeaveRequestDto[]> {
    const typeIds = [...new Set(rows.map((r) => r.leaveTypeId))];
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [types, users] = await Promise.all([
      tx.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } }),
      tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    ]);
    const typeName = new Map((types as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]));
    const userName = new Map((users as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
    return rows.map((r) => this.decorateRequest(r, typeName.get(r.leaveTypeId) ?? null, userName.get(r.userId) ?? null));
  }

  /** ONE person's own leave — naturally bounded by a career, so it is still the
   *  capped most-recent list. The school-wide register is `listRegister`. */
  private async listRequestsWhere(p: Principal, where: { userId?: string }): Promise<LeaveRequestDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.leaveRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: LIST_CAP });
      return this.decorateMany(tx, rows);
    });
  }

  private decorateRequest(
    r: { id: string; leaveTypeId: string; startDate: Date; endDate: Date; days: number; reason: string | null; status: string; workflowRequestId: string | null; attachmentDocId: string | null; createdAt: Date },
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
      attachmentDocId: r.attachmentDocId,
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
