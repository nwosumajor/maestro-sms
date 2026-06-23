// =============================================================================
// WorkflowService — the approval state machine
// =============================================================================
// Deterministic transitions only (WORKFLOW_TRANSITIONS). Every transition writes
// an immutable WorkflowAuditLog row (old/new state, initiator, approver,
// comments). Tenant-isolated (RLS); reviewers cannot act on their OWN request
// (separation of duties); not-visible -> 404.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  WORKFLOW_TRANSITIONS,
  type WorkflowAction,
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

const REVIEW_PERMS = new Set(["workflow.review", "workflow.veto"]);

interface RequestRow {
  id: string;
  state: WorkflowState;
  initiatorId: string;
}

@Injectable()
export class WorkflowService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isReviewer(p: Principal): boolean {
    return p.permissions.some((perm) => REVIEW_PERMS.has(perm));
  }

  async createRequest(
    p: Principal,
    input: { type: WorkflowType; title: string; payload: unknown },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = await tx.workflowRequest.create({
        data: {
          schoolId: p.schoolId,
          type: input.type,
          title: input.title,
          payload: input.payload ?? {},
          state: "DRAFT",
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
  async listRequests(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Reviewers/board see all in-tenant; everyone else sees only what they raised.
      const where = this.isReviewer(p) ? {} : { initiatorId: p.userId };
      return tx.workflowRequest.findMany({ where, orderBy: { createdAt: "desc" } });
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
      const next = WORKFLOW_TRANSITIONS[req.state]?.[action];
      if (!next) {
        throw new ConflictException(`Cannot ${action} from ${req.state}`);
      }

      await tx.workflowRequest.update({ where: { id }, data: { state: next } });
      await this.writeAudit(tx, {
        schoolId: p.schoolId,
        requestId: id,
        initiatorId: req.initiatorId,
        // The actor of a review/veto is an approver; for SUBMIT it's the initiator.
        approverId: action === "SUBMIT" ? null : p.userId,
        oldState: req.state,
        newState: next,
        comments: comments ?? null,
      });
      return { id, state: next };
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
