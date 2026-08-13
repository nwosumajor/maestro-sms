// Mobile-money rail: the payer's three touch points.
//
// The CALLBACK is @Public and UNSIGNED — M-Pesa and MTN do not sign, unlike
// Paystack and Stripe. It is therefore treated as a doorbell: it identifies a
// charge, and everything about money comes from the intent we recorded when the
// charge began. It always answers 200, because a non-2xx makes a rail retry
// forever and no retry can fix a payload we cannot read.

import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { FEES_PERMISSIONS, MOBILE_MONEY_PROVIDERS } from "@sms/types";
import type { MobileMoneyChargeDto, MobileMoneyOptionDto } from "@sms/types";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MobileMoneyService } from "./mobile-money.service";
import { JobRunsService } from "../maintenance/job-runs.service";

const chargeSchema = z.object({
  invoiceId: z.string().uuid(),
  provider: z.enum([
    MOBILE_MONEY_PROVIDERS.MPESA,
    MOBILE_MONEY_PROVIDERS.MTN_MOMO,
    MOBILE_MONEY_PROVIDERS.AIRTEL,
  ]),
  /** Any shape a payer's phone shows them; normalised server-side. */
  phone: z.string().min(6).max(24),
});

@Controller("payments/mobile-money")
export class MobileMoneyController {
  constructor(private readonly mm: MobileMoneyService, private readonly jobRuns: JobRunsService) {}

  /** Which rails this school's payers can use, and which are enabled. */
  @Get("options")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  options(@CurrentPrincipal() p: Principal): Promise<MobileMoneyOptionDto[]> {
    return this.mm.options(p.schoolId);
  }

  /** Send the payment prompt to a payer's handset. Returns an acknowledgement —
   *  mobile money is asynchronous and this is never a receipt. */
  @Post("charge")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  charge(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(chargeSchema)) body: z.infer<typeof chargeSchema>,
  ): Promise<MobileMoneyChargeDto> {
    return this.mm.charge(p, body);
  }

  /** The payer's screen polls this — the handset approval happens out of band. */
  @Get("status")
  @RequirePermission(FEES_PERMISSIONS.FEE_READ)
  status(@CurrentPrincipal() p: Principal, @Query("reference") reference: string) {
    return this.mm.status(p, reference);
  }

  /**
   * The rail's notification. Public, unsigned, always 200.
   *
   * BOTH VERBS, deliberately. Paystack and Stripe POST; MTN MoMo's documented
   * callback for `requesttopay` is a PUT of the transaction object. A route that
   * accepts only POST answers 404 to it, and a 404 to a callback has exactly the
   * failure shape we already fixed once on M-Pesa — the payer is debited, the
   * invoice is never credited, and nothing but an access log records it.
   *
   * Accepting both costs nothing: the handler is idempotent and reads the body,
   * never the verb. It also stops this being a question anyone has to be right
   * about, which matters more than knowing which verb MTN uses this year.
   *
   * TWO HANDLERS, not two decorators on one. Nest's @Post/@Put both write the
   * same METHOD_METADATA key, so stacking them registers only the lower one and
   * silently drops the other — which would have looked exactly like a fix while
   * leaving the bug in place.
   */
  @Public()
  @Post("callback/:provider")
  callback(@Param("provider") provider: string, @Body() body: unknown): Promise<{ ok: true }> {
    return this.mm.handleCallback(provider, body);
  }

  /**
   * Run the recovery sweep now. Same permission as the card reconciliation sweep
   * (`fee.reconcile.run`, super_admin-only): it is a cross-tenant operation that
   * settles money, so it is not a school-level button.
   */
  @Post("recovery/run")
  @RequirePermission(FEES_PERMISSIONS.FEE_RECONCILE_RUN)
  runRecovery() {
    return this.jobRuns.record("payments.mobileMoneyRecovery", "MANUAL", () =>
      this.mm.recoverPending("MANUAL"),
    );
  }

  /** @see callback — MTN MoMo delivers the same payload as a PUT. */
  @Public()
  @Put("callback/:provider")
  callbackPut(@Param("provider") provider: string, @Body() body: unknown): Promise<{ ok: true }> {
    return this.mm.handleCallback(provider, body);
  }
}
