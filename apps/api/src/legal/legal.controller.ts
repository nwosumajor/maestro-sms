// =============================================================================
// LegalController — clickwrap acceptance of the platform legal pack (ALWAYS-ON)
// =============================================================================
// The legal pack (MSA/DPA/Privacy/Refunds/Cyber) is published on the web at
// /legal/* with a version (LEGAL_DOCS_VERSION). Acceptance evidence lives in
// three places: the public onboarding form (stored on the request), the
// APPEND-ONLY legal_acceptance ledger (this controller), and every checkout's
// audit metadata. billing.manage accepts on the school's behalf — the same
// people the MSA binds financially.

import { Controller, Get, Post } from "@nestjs/common";
import { BILLING_PERMISSIONS, LEGAL_DOCS_VERSION } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { LegalService } from "./legal.service";

@Controller("legal")
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  /** Has THIS school accepted the current legal-pack version? (banner check) */
  @Get("acceptance/status")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_READ)
  status(@CurrentPrincipal() p: Principal) {
    return this.legal.status(p);
  }

  /** Record the caller's acceptance of the CURRENT version for their school. */
  @Post("acceptance")
  @RequirePermission(BILLING_PERMISSIONS.BILLING_MANAGE)
  accept(@CurrentPrincipal() p: Principal) {
    return this.legal.accept(p, LEGAL_DOCS_VERSION, "IN_APP");
  }
}
