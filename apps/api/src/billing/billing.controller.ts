// =============================================================================
// BillingController — school self-serve subscription (ALWAYS-ON, no @RequireModule)
// =============================================================================
// Billing is orthogonal to the module-entitlement layer it sells, so it is never
// itself module-gated (like operator/auth/privacy). A school's principal/
// school_admin reads the overview and starts a checkout; checkout is step-up
// gated (money + a privilege change, consistent with maker-checker / impersonation).
// The Paystack webhook is NOT here — it stays on the single @Public fees route and
// is dispatched to BillingService by metadata.kind (Paystack allows one webhook URL).
// =============================================================================

import { Body, Controller, Get, Post } from "@nestjs/common";
import { BILLING_CYCLES, BILLING_PERMISSIONS, PLANS } from "@sms/types";
import type { BillingOverviewDto, CheckoutInitResultDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { BillingService } from "./billing.service";

const checkoutSchema = z.object({
  plan: z.enum([PLANS.STANDARD, PLANS.ENTERPRISE]),
  billingCycle: z.enum([BILLING_CYCLES.MONTH, BILLING_CYCLES.TERM, BILLING_CYCLES.YEAR]),
});

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** The billing screen: current subscription + per-tier quotes + history. */
  @Get()
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  overview(@CurrentPrincipal() p: Principal): Promise<BillingOverviewDto> {
    return this.billing.getOverview(p);
  }

  /** Start a hosted Paystack checkout for a tier. Step-up re-auth required. */
  @Post("checkout/init")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  @RequireStepUp()
  checkout(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ): Promise<CheckoutInitResultDto> {
    return this.billing.initCheckout(p, body);
  }

  /** super_admin manual dunning sweep (the scheduled job runs daily). */
  @Post("dunning/run")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_DUNNING_RUN)
  dunning(@CurrentPrincipal() p: Principal) {
    return this.billing.runDunning(p);
  }
}
