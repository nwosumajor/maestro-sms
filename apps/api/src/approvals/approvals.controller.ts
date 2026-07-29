import { Controller, Get } from "@nestjs/common";
import type { PendingApprovalDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { PendingApprovalsService } from "./pending-approvals.service";

// ALWAYS-ON (no @RequireModule): approvals span modules a school may or may not
// have enabled, and the aggregator only ever reads sources the caller already
// has permission for.
@Controller()
export class ApprovalsController {
  constructor(private readonly pending: PendingApprovalsService) {}

  /**
   * Everything pending THIS caller's decision, across every module.
   *
   * Deliberately NO @RequirePermission: there is no single permission that means
   * "an approver" — the roles differ per source (fee.approve, hr.salary.approve,
   * security.elevation.approve, …). Instead each SOURCE is gated individually
   * inside the service, exactly like GlobalSearch gates each category. A caller
   * holding none of them simply gets an empty list.
   */
  @Get("approvals/pending")
  list(@CurrentPrincipal() p: Principal): Promise<PendingApprovalDto[]> {
    return this.pending.listPending(p);
  }
}
