import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { WorkflowInboxItemDto } from "@sms/types";
import { z } from "zod";
import { WORKFLOW_PERMISSIONS, WORKFLOW_TYPES } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { WorkflowService } from "./workflow.service";

const createSchema = z.object({
  type: z.enum(WORKFLOW_TYPES),
  title: z.string().min(1).max(200),
  payload: z.record(z.unknown()).default({}),
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
    body: { type: (typeof WORKFLOW_TYPES)[number]; title: string; payload: Record<string, unknown> },
  ) {
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

  @Get(":id")
  @RequirePermission(WORKFLOW_PERMISSIONS.READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    return this.workflow.getRequest(p, id);
  }
}
