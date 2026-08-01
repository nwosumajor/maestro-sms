// Mobile-money rail: the payer's three touch points.
//
// The CALLBACK is @Public and UNSIGNED — M-Pesa and MTN do not sign, unlike
// Paystack and Stripe. It is therefore treated as a doorbell: it identifies a
// charge, and everything about money comes from the intent we recorded when the
// charge began. It always answers 200, because a non-2xx makes a rail retry
// forever and no retry can fix a payload we cannot read.

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { FEES_PERMISSIONS, MOBILE_MONEY_PROVIDERS } from "@sms/types";
import type { MobileMoneyChargeDto, MobileMoneyOptionDto } from "@sms/types";
import { Public } from "../auth/public.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { MobileMoneyService } from "./mobile-money.service";

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
  constructor(private readonly mm: MobileMoneyService) {}

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

  /** The rail's notification. Public, unsigned, always 200. */
  @Public()
  @Post("callback/:provider")
  callback(@Param("provider") provider: string, @Body() body: unknown): Promise<{ ok: true }> {
    return this.mm.handleCallback(provider, body);
  }
}
