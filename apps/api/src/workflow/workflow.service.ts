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
  LIST_CAP,
  STAFF_REQUEST_CHAIN,
  WORKFLOW_PERMISSIONS,
  WORKFLOW_TRANSITIONS,
  type WorkflowAction,
  type WorkflowApproverOptionDto,
  type WorkflowInboxItemDto,
  type WorkflowDetailDto,
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
  /** True when the approver's authority for this stage came from an elevation
   *  grant rather than their role — the cover case. Recorded because the trail
   *  should show that a stand-in decided it, not merely who. */
  viaElevation?: boolean;
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
  createdAt: Date;
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
        // ON ROLL. Routing a stage to somebody who has already left creates a
        // request that is stuck the moment it is submitted. The review path
        // now falls back when an approver leaves AFTER routing, but there is
        // no reason to allow it at the outset.
        status: "ACTIVE",
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
          // Never offer somebody who has left as an approver — the picker is
          // where the bad choice would be made.
          status: "ACTIVE",
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
    // Pure read → replica path (Phase 1). scale: reviewers see the whole tenant's
    // requests, which grows without bound over time — cap to the most-recent page.
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // Reviewers/board see all in-tenant; everyone else sees only what they raised.
      const where = this.isReviewer(p) ? {} : { initiatorId: p.userId };
      const rows = await tx.workflowRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: LIST_CAP });
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
          // ONE named field, never the raw payload. An approver needs the facts
          // behind a request — a title alone is not enough to decide on, least
          // of all one that ends a child's access — but payloads carry ids and
          // whatever a future type puts there, so only a summary a service
          // deliberately wrote for the approver is surfaced.
          summary: (r.payload as { summary?: unknown } | null)?.summary
            ? String((r.payload as { summary: unknown }).summary).slice(0, 300)
            : null,
        };
      });
    });
  }

  /**
   * The whole story of one request: the chain as designed, who decided each
   * stage, and the immutable trail.
   *
   * It used to return the raw row and the raw trail, and NO PAGE CALLED IT — so
   * a school could see a request was pending and act on it, but could never
   * afterwards see who approved which stage. A maker-checker record that cannot
   * be read is most of the way to not having one.
   *
   * The field this was really missing is `viaElevation`. The engine records it
   * on every approval — "the trail should show that a stand-in decided it, not
   * merely who", says the comment where it is written — into a JSON column
   * nothing read, so a stage approved under a temporary grant looked identical
   * to one approved by the person who holds that authority every day.
   *
   * Same scope as before: a reviewer, or the initiator of this request. 404 for
   * anyone else, never 403.
   */
  async getRequest(p: Principal, id: string): Promise<WorkflowDetailDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const req = (await tx.workflowRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!req) throw new NotFoundException("Request not found");
      if (!this.isReviewer(p) && req.initiatorId !== p.userId) {
        throw new NotFoundException("Request not found"); // 404, not 403
      }
      const trail = (await tx.workflowAuditLog.findMany({
        where: { requestId: id },
        orderBy: { timestamp: "asc" },
      })) as Array<{
        timestamp: Date;
        approverId: string | null;
        initiatorId: string;
        oldState: string;
        newState: string;
        comments: string | null;
      }>;

      const stages = (req.stages as WorkflowStage[] | null) ?? [];
      const approvals = (req.approvals as StageApproval[] | null) ?? [];
      // One lookup for every person named anywhere in the story.
      const ids = [
        ...new Set(
          [
            req.initiatorId,
            ...approvals.map((a) => a.approverId),
            ...stages.map((st) => st.approverId).filter(Boolean),
            ...trail.map((t) => t.approverId).filter(Boolean),
          ].filter((v): v is string => !!v),
        ),
      ];
      const people = (await tx.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })) as Array<{ id: string; name: string }>;
      const nameOf = new Map(people.map((u) => [u.id, u.name]));

      const approvalByStage = new Map(approvals.map((a) => [a.stageKey, a]));
      return {
        id: req.id,
        type: req.type,
        state: req.state,
        initiatorId: req.initiatorId,
        initiatorName: nameOf.get(req.initiatorId) ?? "Unknown",
        createdAt: req.createdAt,
        // Same rule as the inbox list: only a summary a SERVICE wrote, never
        // the raw payload, whatever a future type puts in there.
        summary: (req.payload as { summary?: unknown } | null)?.summary
          ? String((req.payload as { summary: unknown }).summary).slice(0, 300)
          : null,
        currentStage: req.currentStage,
        stageCount: stages.length,
        stages: stages.map((st) => {
          const decided = approvalByStage.get(st.key);
          return {
            key: st.key,
            label: st.label,
            routedToName: st.approverId ? nameOf.get(st.approverId) ?? st.approverName ?? null : null,
            decidedBy: decided
              ? {
                  stageKey: decided.stageKey,
                  stageLabel: st.label,
                  approverId: decided.approverId,
                  approverName: nameOf.get(decided.approverId) ?? "Unknown",
                  at: new Date(decided.at),
                  viaElevation: decided.viaElevation === true,
                }
              : null,
          };
        }),
        trail: trail.map((t) => ({
          at: t.timestamp,
          actorName: t.approverId ? nameOf.get(t.approverId) ?? null : null,
          oldState: t.oldState,
          newState: t.newState,
          comments: t.comments,
        })),
      };
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
      // Set when a routed stage was acted on by somebody OTHER than its named
      // approver, because that approver has left. Recorded on the audit entry —
      // a stage that quietly changed hands must be visible afterwards.
      let routedApproverGone: string | undefined;

      // A ROUTED stage names its approver: only that person may act on it —
      // including REQUEST_REVISION, so a bystander reviewer can't bounce a
      // request that was routed past them.
      if (
        isStaged &&
        (action === "APPROVE" || action === "REJECT" || action === "REQUEST_REVISION")
      ) {
        const named = stages[req.currentStage]?.approverId;
        if (named && named !== p.userId) {
          // …UNLESS THE NAMED APPROVER HAS LEFT THE SCHOOL.
          //
          // A routed stage names ONE person, and every exit from PENDING_REVIEW
          // — approve, reject, even bouncing it back — is gated to them. There
          // is no cancel, no withdraw and no reassign. So when that person
          // left, the request was stuck FOREVER, and silently: the initiator
          // saw "pending", the principal was refused, and nothing anywhere said
          // the approver no longer existed. Confirmed by exiting a routed
          // approver and finding all six escape routes closed.
          //
          // Falling back to the stage's PERMISSION gate is the fix that
          // self-heals. The routing is honoured while the person is there, and
          // when they are gone the stage becomes an ordinary one that any
          // eligible reviewer can act on — still a different person from the
          // initiator, still holding the right permission, still recorded. A
          // reassign button would have been more machinery AND would have
          // needed somebody to notice the deadlock first, which is precisely
          // what nobody does.
          const stillHere = await tx.user.findFirst({
            where: { id: named, status: "ACTIVE" },
            select: { id: true },
          });
          if (stillHere) {
            throw new ForbiddenException(
              `This stage is routed to ${stages[req.currentStage]?.approverName ?? "a designated approver"}`,
            );
          }
          routedApproverGone = stages[req.currentStage]?.approverName ?? "the routed approver";
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
          ...(p.elevated?.includes(stage.permission) ? { viaElevation: true } : {}),
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
        comments:
          comments ??
          ([
            stageNote,
            // The immutable trail says so too, not only the approvals JSON. The
            // detail view can be changed; this row cannot.
            p.elevated?.includes(stages[req.currentStage]?.permission ?? "") &&
              "decided under a temporary elevation grant",
            routedApproverGone && `routed approver ${routedApproverGone} has left the school`,
          ]
            .filter(Boolean)
            .join("; ") ||
            null),
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
