import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { MemberScanDto, ScanRecordResultDto } from "@sms/types";
import { isScanPurpose } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { MemberScanService } from "./member-scan.service";

@Controller("members")
export class MemberScanController {
  constructor(private readonly scan: MemberScanService) {}

  /**
   * Resolve a scanned ID-card code to a member of the caller's OWN school.
   * `member.scan` gated; tenant-scoped (404 across tenants); audited in-service.
   * The code is a path param (opaque uniqueId, no PII), never a body.
   */
  @Get("scan/:code")
  @RequirePermission("member.scan")
  resolve(@CurrentPrincipal() p: Principal, @Param("code") code: string): Promise<MemberScanDto> {
    return this.scan.resolve(p, code);
  }

  /**
   * RECORD an action for a scanned member (check-in / check-out / library /
   * exam). CHECK_IN of a student marks them present in today's register.
   * Same tenant-scoping, permission and audit as the lookup.
   */
  @Post("scan/:code")
  @RequirePermission("member.scan")
  record(
    @CurrentPrincipal() p: Principal,
    @Param("code") code: string,
    @Body() body: { purpose?: string; note?: string },
  ): Promise<ScanRecordResultDto> {
    const purpose = body?.purpose;
    if (!purpose || !isScanPurpose(purpose)) {
      throw new BadRequestException("Unknown scan purpose");
    }
    return this.scan.record(p, code, purpose, body.note ?? null);
  }
}
