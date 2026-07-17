// Multi-school GROUP console (paid add-on, MODULES.GROUP on the DIRECTOR's own
// school). No dedicated permission: directorship in the operator-managed
// registry is the authorization (404-not-403 in the service), so a compromised
// tenant role can never elevate itself into cross-school reads.

import { Controller, Get } from "@nestjs/common";
import { MODULES } from "@sms/types";
import type { GroupOverviewDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { GroupService } from "./group.service";

@RequireModule(MODULES.GROUP)
@Controller("group")
export class GroupController {
  constructor(private readonly group: GroupService) {}

  /** The caller's cross-campus dashboard (directors only; audited). */
  @Get("overview")
  overview(@CurrentPrincipal() p: Principal): Promise<GroupOverviewDto> {
    return this.group.overview(p);
  }
}
