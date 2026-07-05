// =============================================================================
// WorkflowService — the approval state machine (single- AND multi-stage)
// =============================================================================
// Deterministic transitions only (WORKFLOW_TRANSITIONS). Every transition writes
// an immutable WorkflowAuditLog row (old/new state, initiator, approver,
// comments). Tenant-isolated (RLS); reviewers cannot act on their OWN request
// (separation of duties); not-visible -> 404.
//
// MULTI-STAGE: a request may carry an ordered `stages` chain (e.g. the staff
// leave chain head → HR → principal). An APPROVE advances `currentStage` and
// stays PENDING_REVIEW until the LAST stage finalizes to APPROVED. Each stage's
// approver must hold that stage's granular permission AND must not have acted on
// the request before (so every stage is decided by a different person). On the
// terminal state a finalized-hook fan-out runs IN-TX (HR leave reacts there).
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
import {
  CUSTOM_CHAIN_MAX_STAGES,
  CUSTOM_CHAIN_MIN_STAGES,
  STAGED_WORKFLOW_TYPES,
  STAFF_REQUEST_CHAIN,
  WORKFLOW_PERMISSIONS,
  WORKFLOW_TRANSITIONS,
  type WorkflowAction,
  type WorkflowApproverOptionDto,
  type WorkflowInboxItemDto,
  type WorkflowStage,
  type WorkflowState,
  type WorkflowType,
} from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { WorkflowHooksService } from "./workflow-hooks.service";

const REVIEW_PERMS = new Set(["workflow.review", "workflow.veto"]);

interface StageApproval {
  stageKey: string;
  approverId: string;
  at: string;
}

interface RequestRow {
  id: string;
  type: string;
  state: WorkflowState;
  initiatorId: string;
  payload: unknown;
  stages: unknown;
  currentStage: number;
  approvals: unknown;
}

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly hooks: WorkflowHooksService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isReviewer(p: Principal): boolean {
    return p.permissions.some((perm) => REVIEW_PERMS.has(perm));
  }

  async createRequest(
    p: Principal,
    input: {
      type: WorkflowType;
      title: string;
      payload: unknown;
      stages?: WorkflowStage[];
      /** Initiator-routed chain: 2–3 named senior staff (workflow.review
       *  holders). Ignored when a system caller supplies `stages` — fixed
       *  system chains (GRADE_PUBLISH, FEE_SCHEDULE) can never be re-routed. */
      approverIds?: string[];
    },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Precedence: explicit system chain > initiator-routed chain > the
      // standard chain for staged types > single-stage.
      let stages: WorkflowStage[];
      if (input.stages) {
        stages = input.stages;
      } else if (input.approverIds && input.approverIds.length > 0) {
        stages = await this.buildCustomChain(tx, p, input.approverIds);
      } else {
        stages = STAGED_WORKFLOW_TYPES.has(input.type) ? STAFF_REQUEST_CHAIN : [];
      }
      const req = await tx.workflowRequest.create({
        data: {
          schoolId: p.schoolId,
          type: input.type,
          title: input.title,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          state: "DRAFT",
          stages: stages as unknown as Prisma.InputJsonValue,
          currentStage: 0,
          approvals: [] as unknown as Prisma.InputJsonValue,
          initiatorId: p.userId,
        },
      });
      await this.writeAudit(tx, {
        schoolId: p.schoolId,
        requestId: req.id,
        initiatorId: p.userId,
        approverId: null,
        oldState: null,
        newState: "DRAFT",
        comments: "created",
      });
      return req;
    });
  }

  /** Build an initiator-routed chain from named senior staff. Each pick must be
   *  a DIFFERENT in-tenant holder of workflow.review, and never the initiator
   *  (separation of duties starts at routing time). */
  private async buildCustomChain(
    tx: TenantTx,
    p: Principal,
    approverIds: string[],
  ): Promise<WorkflowStage[]> {
    if (
      approverIds.length < CUSTOM_CHAIN_MIN_STAGES ||
      approverIds.length > CUSTOM_CHAIN_MAX_STAGES
    ) {
      throw new BadRequestException(
        `Pick ${CUSTOM_CHAIN_MIN_STAGES} or ${CUSTOM_CHAIN_MAX_STAGES} approvers for a routed request`,
      );
    }
    if (new Set(approverIds).size !== approverIds.length) {
      throw new BadRequestException("Each approval stage must be a different person");
    }
    if (approverIds.includes(p.userId)) {
      throw new BadRequestException("You cannot route an approval stage to yourself");
    }
    // Every pick must be reviewer-capable (role carrying workflow.review) —
    // RLS scopes the lookup to the caller's school, so a cross-tenant id
    // simply doesn't resolve (404-equivalent: rejected as not eligible).
    const eligible = await tx.user.findMany({
      where: {
        id: { in: approverIds },
        roles: {
          some: {
            role: {
              permissions: {
                some: { permission: { key: WORKFLOW_PERMISSIONS.REVIEW } },
              },
            },
          },
        },
      },
      select: { id: true, name: true },
    });
    const byId = new Map(eligible.map((u) => [u.id, u.name]));
    const missing = approverIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        "Every approver must be a senior staff member with review rights",
      );
    }
    // Order is the initiator's chosen route; the stage gate is the NAMED person
    // (permission stays the coarse review gate they already hold).
    return approverIds.map((id, i) => ({
      key: `ROUTE_${i + 1}`,
      label: byId.get(id)!,
      permission: WORKFLOW_PERMISSIONS.REVIEW,
      approverId: id,
      approverName: byId.get(id)!,
    }));
  }

  /** Senior staff the caller may route approval stages to: in-tenant holders of
   *  workflow.review (principal, school_admin, head_teacher, head_admin,
   *  hr_manager), excluding the caller themselves. */
  async listEligibleApprovers(p: Principal): Promise<WorkflowApproverOptionDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const users = await tx.user.findMany({
        where: {
          id: { not: p.userId },
          roles: {
            some: {
              role: {
                permissions: {
                  some: { permission: { key: WORKFLOW_PERMISSIONS.REVIEW } },
                },
              },
            },
          },
        },
        select: {
          id: true,
          name: true,
          roles: { select: { role: { select: { name: true } } } },
        },
        orderBy: { name: "asc" },
      });
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        roles: u.roles.map((r) => r.role.name),
      }));
    });
  }

  /** Initiator submits (DRAFT|REVISION_REQUESTED -> PENDING_REVIEW). */
  async submit(p: Principal, id: string, comments?: string) {
    return this.transition(p, id, "SUBMIT", comments, { mustBeInitiator: true });
  }

  /** Reviewer approves / rejects / requests revision on a PENDING_REVIEW request. */
  async review(p: Principal, id: string, action: WorkflowAction, comments?: string) {
    if (action !== "APPROVE" && action !== "REJECT" && action !== "REQUEST_REVISION") {
      throw new BadRequestException("Invalid review action");
    }
    return this.transition(p, id, action, comments, { mustNotBeInitiator: true });
  }

  /** Board veto: override an APPROVED request to REJECTED. */
  async veto(p: Principal, id: string, comments?: string) {
    return this.transition(p, id, "VETO", comments, {});
  }

  // --- reads (scoped) --------------------------------------------------------
  async listRequests(p: Principal): Promise<WorkflowInboxItemDto[]> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Reviewers/board see all in-tenant; everyone else sees only what they raised.
      const where = this.isReviewer(p) ? {} : { initiatorId: p.userId };
      const rows = await tx.workflowRequest.findMany({ where, orderBy: { createdAt: "desc" } });
      return rows.map((r) => {
        const stages = (r.stages as WorkflowStage[] | null) ?? [];
        const pending = r.state === "PENDING_REVIEW" ? (stages[r.currentStage]?.label ?? null) : null;
        return {
          id: r.id,
          type: r.type,
          title: r.title,
          state: r.state,
          initiatorId: r.initiatorId,
          createdAt: r.createdAt,
          currentStage: r.currentStage,
          stageCount: stages.length,
          stageLabel: pending,
        };
      });
    });
  }

  async getRequest(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = (await tx.workflowRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!req) throw new NotFoundException("Request not found");
      if (!this.isReviewer(p) && req.initiatorId !== p.userId) {
        throw new NotFoundException("Request not found"); // 404, not 403
      }
      const trail = await tx.workflowAuditLog.findMany({
        where: { requestId: id },
        orderBy: { timestamp: "asc" },
      });
      return { request: req, auditTrail: trail };
    });
  }

  // --- the one place a state actually changes --------------------------------
  private async transition(
    p: Principal,
    id: string,
    action: WorkflowAction,
    comments: string | undefined,
    rules: { mustBeInitiator?: boolean; mustNotBeInitiator?: boolean },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = (await tx.workflowRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!req) throw new NotFoundException("Request not found");

      // Relationship rules (separation of duties).
      if (rules.mustBeInitiator && req.initiatorId !== p.userId) {
        throw new NotFoundException("Request not found");
      }
      if (rules.mustNotBeInitiator && req.initiatorId === p.userId) {
        throw new ForbiddenException("You cannot review your own request");
      }

      // Deterministic transition check.
      const baseNext = WORKFLOW_TRANSITIONS[req.state]?.[action];
      if (!baseNext) {
        throw new ConflictException(`Cannot ${action} from ${req.state}`);
      }

      const stages = (req.stages as WorkflowStage[] | null) ?? [];
      const isStaged = stages.length > 0;
      const approvals = (req.approvals as StageApproval[] | null) ?? [];

      let nextState: WorkflowState = baseNext;
      let nextStage = req.currentStage;
      let nextApprovals = approvals;
      let stageNote: string | undefined;

      // A ROUTED stage names its approver: only that person may act on it —
      // including REQUEST_REVISION, so a bystander reviewer can't bounce a
      // request that was routed past them.
      if (
        isStaged &&
        (action === "APPROVE" || action === "REJECT" || action === "REQUEST_REVISION")
      ) {
        const named = stages[req.currentStage]?.approverId;
        if (named && named !== p.userId) {
          throw new ForbiddenException(
            `This stage is routed to ${stages[req.currentStage]?.approverName ?? "a designated approver"}`,
          );
        }
      }

      if (isStaged && (action === "APPROVE" || action === "REJECT")) {
        const stage = stages[req.currentStage];
        if (!stage) throw new ConflictException("No active approval stage");
        // The actor must hold THIS stage's granular permission.
        if (!p.permissions.includes(stage.permission)) {
          throw new ForbiddenException(`You are not the ${stage.label} approver`);
        }
        // …and must not have already acted on this request (distinct approver/stage).
        if (approvals.some((a) => a.approverId === p.userId)) {
          throw new ForbiddenException("You have already acted on this request");
        }
        const record: StageApproval = {
          stageKey: stage.key,
          approverId: p.userId,
          at: new Date().toISOString(),
        };
        if (action === "APPROVE") {
          nextApprovals = [...approvals, record];
          if (req.currentStage < stages.length - 1) {
            // Not the last stage → advance, remain pending.
            nextState = "PENDING_REVIEW";
            nextStage = req.currentStage + 1;
            stageNote = `stage ${stage.key} approved (${req.currentStage + 1}/${stages.length})`;
          } else {
            nextState = "APPROVED"; // final stage → finalize
            stageNote = `stage ${stage.key} approved (final)`;
          }
        } else {
          // REJECT at any stage is terminal.
          nextApprovals = [...approvals, record];
          stageNote = `rejected at stage ${stage.key}`;
        }
      } else if (isStaged && action === "REQUEST_REVISION") {
        // Send back to the initiator; restart the chain on resubmission.
        nextStage = 0;
        nextApprovals = [];
      }

      // OPTIMISTIC CONCURRENCY: only write if the row is STILL in the exact
      // state/stage we read. A concurrent reviewer who advanced or finalized the
      // request changes `state`/`currentStage`, so this matches 0 rows and we
      // reject — preventing a lost approval or a double stage-advance (which
      // would break the separation-of-duties guarantee). No version column
      // needed: (state, currentStage) is the version for a staged workflow.
      const written = await tx.workflowRequest.updateMany({
        where: { id, state: req.state, currentStage: req.currentStage },
        data: {
          state: nextState,
          currentStage: nextStage,
          approvals: nextApprovals as unknown as Prisma.InputJsonValue,
        },
      });
      if (written.count === 0) {
        throw new ConflictException("This request was just updated by someone else — reload and try again.");
      }
      await this.writeAudit(tx, {
        schoolId: p.schoolId,
        requestId: id,
        initiatorId: req.initiatorId,
        approverId: action === "SUBMIT" ? null : p.userId,
        oldState: req.state,
        newState: nextState,
        comments: comments ?? stageNote ?? null,
      });

      // Fan out to reactors (e.g. HR leave) on a terminal state, in-tx.
      if (nextState === "APPROVED" || nextState === "REJECTED") {
        await this.hooks.runFinalized(tx, {
          id: req.id,
          schoolId: p.schoolId,
          type: req.type,
          state: nextState,
          payload: req.payload,
          initiatorId: req.initiatorId,
        });
      }
      return { id, state: nextState, currentStage: nextStage };
    });
  }

  private async writeAudit(
    tx: TenantTx,
    row: {
      schoolId: string;
      requestId: string;
      initiatorId: string;
      approverId: string | null;
      oldState: string | null;
      newState: string;
      comments: string | null;
    },
  ) {
    // Immutable: the RLS migration permits INSERT only on workflow_audit_log.
    await tx.workflowAuditLog.create({ data: row });
  }
}
