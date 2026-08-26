import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { AnalyticsOverviewDto } from "@sms/types";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { AnalyticsService } from "./analytics.service";
import { safeFilename } from "../documents/safe-content-type";

// Role-scoped aggregates. No special permission: any authenticated user gets
// their OWN scope (the service decides school-wide vs family from their roles).
@RequireModule(MODULES.ANALYTICS)
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * The overview over a chosen window.
   *
   * No range = the CURRENT TERM, so these figures agree with the term-scoped report
   * card by default. `termId` picks another term; `from`/`to` give an explicit range.
   * The window actually used is echoed back on the response so the page can state it.
   */
  @Get("overview")
  overview(
    @CurrentPrincipal() p: Principal,
    @Query("termId") termId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(p, { termId, from, to });
  }

  /** The same figures as CSV, for a board pack. Identical scoping — it can only ever
   *  export what the caller already sees on the page. */
  @Get("overview.csv")
  async overviewCsv(
    @CurrentPrincipal() p: Principal,
    @Res() res: Response,
    @Query("termId") termId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const { csv, filename } = await this.analytics.overviewCsv(p, { termId, from, to });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(filename)}"`);
    res.send(csv);
  }
}
