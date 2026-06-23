import { Controller, Get } from "@nestjs/common";
import type { AnalyticsOverviewDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { AnalyticsService } from "./analytics.service";

// Role-scoped aggregates. No special permission: any authenticated user gets
// their OWN scope (the service decides school-wide vs family from their roles).
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  overview(@CurrentPrincipal() p: Principal): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(p);
  }
}
