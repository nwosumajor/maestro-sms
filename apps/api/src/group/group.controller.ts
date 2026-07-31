// Multi-school GROUP console (paid add-on, MODULES.GROUP on the DIRECTOR's own
// school). No dedicated permission: directorship in the operator-managed
// registry is the authorization (404-not-403 in the service), so a compromised
// tenant role can never elevate itself into cross-school reads.

import { Controller, Get, Param, Query } from "@nestjs/common";
import { MODULES } from "@sms/types";
import type { GroupOverviewDto, GroupSchoolDetailDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { GroupService } from "./group.service";

@RequireModule(MODULES.GROUP)
@Controller("group")
export class GroupController {
  constructor(private readonly group: GroupService) {}

  /** The caller's cross-campus dashboard (directors only; audited).
   *
   *  `?groupId=` picks among the groups they direct — a proprietor with two chains
   *  used to see only the first, silently. `?period=` widens the window beyond the
   *  single day the figures used to cover. */
  @Get("overview")
  overview(
    @CurrentPrincipal() p: Principal,
    @Query("groupId") groupId?: string,
    @Query("period") period?: string,
  ): Promise<GroupOverviewDto> {
    return this.group.overview(p, { groupId, period });
  }

  /** One campus in depth — trends and where the money is stuck. Aggregates only:
   *  a director never reaches a pupil, an invoice or a record through this. 404
   *  unless the campus is in a group they direct. */
  @Get("schools/:schoolId")
  schoolDetail(@CurrentPrincipal() p: Principal, @Param("schoolId") schoolId: string): Promise<GroupSchoolDetailDto> {
    return this.group.schoolDetail(p, schoolId);
  }

  /** The overview as CSV, for a board pack. Same scoping and the same audit entry
   *  as the screen — an export is a read, not a lesser thing. */
  @Get("overview.csv")
  async csv(
    @CurrentPrincipal() p: Principal,
    @Query("groupId") groupId?: string,
    @Query("period") period?: string,
  ): Promise<string> {
    return this.group.overviewCsv(p, { groupId, period });
  }
}
