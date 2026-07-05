import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { WorkflowApproverOptionDto, WorkflowInboxItemDto } from "@sms/types";
import { z } from "zod";
import { canInitiateWorkflowType, WORKFLOW_PERMISSIONS, WORKFLOW_TYPES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { WorkflowService } from "./workflow.service";

const createSchema = z.object({
  type: z.enum(WORKFLOW_TYPES),
  title: z.string().min(1).max(200),
  payload: z.record(z.unknown()).default({}),
  /** Optional initiator-routed chain: 2–3 named senior staff. Deep validation
   *  (distinct, reviewer-capable, never the initiator) lives in the service. */
  approverIds: z.array(z.string().uuid()).min(2).max(3).optional(),
});
const reviewSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "REQUEST_REVISION"]),
  comments: z.string().max(2000).optional(),
});
const commentSchema = z.object({ comments: z.string().max(2000).optional() });

@RequireModule(MODULES.WORKFLOW)
@Controller("workflows")
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Post()
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(createSchema))
    body: {
      type: (typeof WORKFLOW_TYPES)[number];
      title: string;
      payload: Record<string, unknown>;
      approverIds?: string[];
    },
  ) {
    // Per-type initiation rules: PURCHASE_ORDER/DISCIPLINARY need an extra perm;
    // LMS_CONTENT_PUBLISH is system-only (LmsContentService calls the service
    // directly, bypassing this endpoint). Self-service types (LEAVE/STAFF_REQUEST)
    // pass for any staff member with workflow.create.
    if (!canInitiateWorkflowType(body.type, p.permissions)) {
      throw new ForbiddenException("You cannot initiate this type of request");
    }
    return this.workflow.createRequest(p, body);
  }

  @Post(":id/submit")
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  submit(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: { comments?: string },
  ) {
    return this.workflow.submit(p, id, body.comments);
  }

  @Post(":id/review")
  @RequirePermission(WORKFLOW_PERMISSIONS.REVIEW)
  review(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reviewSchema))
    body: { action: "APPROVE" | "REJECT" | "REQUEST_REVISION"; comments?: string },
  ) {
    return this.workflow.review(p, id, body.action, body.comments);
  }

  @Post(":id/veto")
  @RequirePermission(WORKFLOW_PERMISSIONS.VETO)
  veto(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: { comments?: string },
  ) {
    return this.workflow.veto(p, id, body.comments);
  }

  @Get()
  @RequirePermission(WORKFLOW_PERMISSIONS.READ)
  list(@CurrentPrincipal() p: Principal): Promise<WorkflowInboxItemDto[]> {
    return this.workflow.listRequests(p);
  }

  /** Senior staff the caller may route approval stages to. MUST be declared
   *  before the :id route or "approvers" would be captured as an id. */
  @Get("approvers")
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  approvers(@CurrentPrincipal() p: Principal): Promise<WorkflowApproverOptionDto[]> {
    return this.workflow.listEligibleApprovers(p);
  }

  @Get(":id")
  @RequirePermission(WORKFLOW_PERMISSIONS.READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.workflow.getRequest(p, id);
  }
}
