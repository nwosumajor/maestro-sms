import { Controller, Get } from "@nestjs/common";
import { MODULES, SIS_PERMISSIONS } from "@sms/types";
import type { FamilyOverviewDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { ParentService } from "./parent.service";

// The parent portal read. family.read is held by the parent role only; the
// service further scopes every row through ParentChild, so even a staff member
// granted the permission would only see children LINKED to them.
@RequireModule(MODULES.SIS)
@Controller("family")
export class ParentController {
  constructor(private readonly parent: ParentService) {}

  @Get("overview")
  @RequirePermission(SIS_PERMISSIONS.FAMILY_READ)
  overview(@CurrentPrincipal() p: Principal): Promise<FamilyOverviewDto> {
    return this.parent.getFamilyOverview(p);
  }
}
