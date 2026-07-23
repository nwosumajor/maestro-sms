import { Controller, Get, Param } from "@nestjs/common";
import type { MemberScanDto } from "@sms/types";
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
}
