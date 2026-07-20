// =============================================================================
// DisputesController — staff surface for gateway chargeback/dispute tracking
// =============================================================================
// ALL endpoints are fee.manage: parents/students hold fee.read (their own
// invoices), but the dispute list is school-wide finance-internal data —
// coarse fee.read would leak every family's chargebacks to any parent.
// Rows are CREATED only by the webhook (PaymentGatewayService ->
// DisputesService.applyDisputeEvent) — there is no staff create/delete:
// disputes exist because the gateway says so, and their history is permanent
// (rls/78 grants no DELETE).
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { FEES_PERMISSIONS, MODULES } from "@sms/types";
import type { PaymentDisputeDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { DisputesService } from "./disputes.service";

const respondSchema = z.object({ note: z.string().min(1).max(2000) });

@RequireModule(MODULES.FEES)
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get("fees/disputes")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  list(@CurrentPrincipal() p: Principal): Promise<PaymentDisputeDto[]> {
    return this.disputes.list(p);
  }

  @Get("fees/disputes/:id")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  get(@CurrentPrincipal() p: Principal, @Param("id") id: string): Promise<PaymentDisputeDto> {
    return this.disputes.get(p, id);
  }

  @Post("fees/disputes/:id/respond")
  @RequirePermission(FEES_PERMISSIONS.FEE_MANAGE)
  respond(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(respondSchema)) body: z.infer<typeof respondSchema>,
  ): Promise<PaymentDisputeDto> {
    return this.disputes.respond(p, id, body.note);
  }
}
