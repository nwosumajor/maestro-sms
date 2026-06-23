// =============================================================================
// IntegrityRetentionController — manual purge + retention history (per-tenant)
// =============================================================================
// Gated by integrity.retention.run (principal, school_admin). The SCHEDULED
// sweep covers every tenant; this endpoint lets an admin purge / inspect THEIR
// OWN school. schoolId comes from the verified JWT (@CurrentPrincipal), never
// from the request body — there is no cross-tenant lever here.
// =============================================================================

import { Controller, Get, Inject, Post } from "@nestjs/common";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
// --- foundation primitives (do not reimplement) ---
import { RequirePermission } from "../../auth/require-permission.decorator";
import { CurrentPrincipal } from "../../auth/current-principal.decorator";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantDatabase,
} from "../integrity.foundation";
import { IntegrityRetentionService } from "./integrity-retention.service";

@Controller("integrity/retention")
export class IntegrityRetentionController {
  constructor(
    private readonly retention: IntegrityRetentionService,
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
  ) {}

  /** Run retention now for the caller's school only. */
  @Post("run")
  @RequirePermission(INTEGRITY_PERMISSIONS.RETENTION_RUN)
  async run(@CurrentPrincipal() p: Principal) {
    // Read THIS school's configured window from the registry via the tenant
    // runner (RLS-scoped), then purge with the privileged client.
    const days = await this.db.runAsTenant(p, async (tx) => {
      const s = await tx.school.findUnique({
        where: { id: p.schoolId },
        select: { integrityRetentionDays: true },
      });
      return (s?.integrityRetentionDays as number | undefined) ?? 0;
    });
    return this.retention.purgeSchool(p.schoolId, days, "MANUAL");
  }

  /** Immutable retention-run history for the caller's school (RLS-scoped read). */
  @Get("runs")
  @RequirePermission(INTEGRITY_PERMISSIONS.RETENTION_RUN)
  async runs(@CurrentPrincipal() p: Principal) {
    return this.db.runAsTenant(p, (tx) =>
      tx.integrityRetentionRun.findMany({
        where: { schoolId: p.schoolId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    );
  }
}
