import { Controller, Get } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { HrAnalyticsDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { HrAnalyticsService } from "./analytics.service";

@RequireModule(MODULES.HR)
@Controller("hr/analytics")
export class HrAnalyticsController {
  constructor(private readonly analytics: HrAnalyticsService) {}

  @Get()
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  get(@CurrentPrincipal() p: Principal): Promise<HrAnalyticsDto> {
    return this.analytics.getAnalytics(p);
  }
}
