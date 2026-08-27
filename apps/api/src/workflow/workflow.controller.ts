import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { WorkflowApproverOptionDto, WorkflowPageDto, WorkflowDetailDto } from "@sms/types";
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
/** Register filters. All optional — omitting everything gives the most recent
 *  page, which is what the endpoint always returned. `mine` is a string because
 *  it arrives on a query string; anything but "0"/"false" means yes. */
const listQuerySchema = z.object({
  type: z.enum(WORKFLOW_TYPES).optional(),
  state: z.enum(["DRAFT", "PENDING_REVIEW", "REVISION_REQUESTED", "APPROVED", "REJECTED"]).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  mine: z.string().optional(),
});

/**
 * THE ENGINE IS A PRODUCT; THE APPROVALS ARE A CONTROL.
 *
 * This whole controller was gated on MODULES.WORKFLOW, which is a PREMIUM add —
 * and a STANDARD school can RAISE five maker-checker requests, because their
 * producers are gated on modules STANDARD has or are not gated at all:
 * ATTENDANCE_AMENDMENT (attendance), CONTENT_PUBLISH (lms), GRADE_PUBLISH,
 * STUDENT_EXIT and ADMIN_APPOINTMENT (all always-on).
 *
 * Measured live on the demo school set to STANDARD: granting `junior_admin`
 * answered 201 `{pendingApproval:true}` and wrote a PENDING_REVIEW row, while
 * `GET /workflows` answered 404, the nav hid the section, and
 * `/approvals/pending` did not list it. The request was raised, UNDECIDABLE and
 * INVISIBLE — a two-person rule the product imposes and gives no way to finish.
 *
 * So the split is by what the route IS, not by what it touches: AUTHORING a
 * request (the workflow engine sold as a feature) stays PREMIUM; DECIDING one
 * the platform's own controls have already raised is part of the always-on
 * control spine, exactly like `ApprovalsController` beside it.
 *
 * Weakening the control to fit the packaging — applying the change directly
 * where a school lacks the module — was the other option and is the wrong
 * direction: Golden Rule #7 takes the more restrictive branch, and a stale
 * register corrected with no second pair of eyes is what the rule exists to
 * prevent.
 */
@Controller("workflows")
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Post()
  @RequireModule(MODULES.WORKFLOW)
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
  @RequireModule(MODULES.WORKFLOW)
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

  /** The approvals register: filtered, searchable, paged.
   *
   *  Every parameter is optional and the default is what it always was — the
   *  most recent page. `mine=1` narrows to what THIS caller can decide now. */
  @Get()
  @RequirePermission(WORKFLOW_PERMISSIONS.READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<WorkflowPageDto> {
    // A query string carries text, not booleans: present and not an explicit
    // no means yes.
    return this.workflow.listRequests(p, {
      ...query,
      mine: query.mine !== undefined && query.mine !== "0" && query.mine !== "false",
    });
  }

  /** Senior staff the caller may route approval stages to. MUST be declared
   *  before the :id route or "approvers" would be captured as an id. */
  // Authoring aid: it answers "who could decide this if I raised it", so it
  // belongs with the create form rather than with the decision.
  @Get("approvers")
  @RequireModule(MODULES.WORKFLOW)
  @RequirePermission(WORKFLOW_PERMISSIONS.CREATE)
  approvers(@CurrentPrincipal() p: Principal): Promise<WorkflowApproverOptionDto[]> {
    return this.workflow.listEligibleApprovers(p);
  }

  /** The whole story of one request — the chain as designed, who decided each
   *  stage (and whether under an elevation grant), and the immutable trail.
   *  Reviewer or initiator only; 404 for anyone else. */
  @Get(":id")
  @RequirePermission(WORKFLOW_PERMISSIONS.READ)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<WorkflowDetailDto> {
    return this.workflow.getRequest(p, id);
  }
}
