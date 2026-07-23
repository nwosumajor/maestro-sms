// =============================================================================
// AcademicProgressionController — manual cross-tenant "run the sweep now"
// =============================================================================
// The SCHEDULED sweep advances every school whose current term has ended. This
// endpoint lets a platform operator trigger the same sweep on demand (ops /
// verification). It is cross-tenant, so it is gated by platform.operate and is
// NOT tagged with a product module. Per-school on-demand advance is the separate
// tenant-scoped POST /academic/advance-term on the LMS controller.
// =============================================================================

import { Controller, Post } from "@nestjs/common";
import { OPERATOR_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../../auth/require-permission.decorator";
import { AcademicProgressionService } from "./academic-progression.service";

@Controller("academic/progression")
export class AcademicProgressionController {
  constructor(private readonly progression: AcademicProgressionService) {}

  /** Run the auto-progression sweep across all tenants now (platform operator). */
  @Post("run")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  run() {
    return this.progression.runSweep("MANUAL");
  }
}
