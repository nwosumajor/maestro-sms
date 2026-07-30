import { Controller, Get } from "@nestjs/common";
import type { DashboardSummaryDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { DashboardService } from "./dashboard.service";

/**
 * Home-page tile counts. Self-scoped (there is no id to pass), no extra permission —
 * every figure is already scoped to what the caller may see, and each one links to a
 * page that enforces the same rule.
 *
 * ALWAYS-ON: not @RequireModule-gated, because the home page must render for every
 * role even when Analytics or LMS is off for that school.
 */
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("summary")
  summary(@CurrentPrincipal() p: Principal): Promise<DashboardSummaryDto> {
    return this.dashboard.summary(p);
  }
}
