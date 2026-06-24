import { Controller, Get } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { AnalyticsOverviewDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { AnalyticsService } from "./analytics.service";

// Role-scoped aggregates. No special permission: any authenticated user gets
// their OWN scope (the service decides school-wide vs family from their roles).
@RequireModule(MODULES.ANALYTICS)
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  overview(@CurrentPrincipal() p: Principal): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(p);
  }
}
