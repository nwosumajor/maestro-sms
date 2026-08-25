import { Body, Controller, Get, Param, Post , Query } from "@nestjs/common";
import type { MemberScanDto, ScanRecordResultDto, ScanEventDto } from "@sms/types";
import { MODULES, SCAN_PURPOSES, SIS_PERMISSIONS } from "@sms/types";
import { z } from "zod";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireModule } from "../auth/require-module.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { MemberScanService } from "./member-scan.service";

// The scan desk reads the QR printed on an ID CARD, which is what the
// certificate module produces — so it is gated on the same module rather than
// left open. It sat inside `certificate/` untagged while its sibling
// `certificate.controller.ts` carried the tag, which meant every school on the
// STANDARD tier got a PREMIUM feature. Nothing breaks by adding it: a school
// without the certificate module has never had an ID card to scan, and no live
// school has a single scan_event.
/**
 * VALIDATED AT THE BOUNDARY, like the other 334 request bodies.
 *
 * This one was hand-checked: `purpose` was tested with `isScanPurpose` in the
 * method body and `note` was not checked at all — passed through as
 * `body.note ?? null`. Two consequences, both measured against the running
 * service:
 *
 *   a note that is not a string      -> HTTP 500. `note?.trim()` on an object
 *                                       throws, so a client's mistake became an
 *                                       internal error, a Sentry event and a
 *                                       stack trace, instead of a 400.
 *   a note of 90,000 characters      -> HTTP 201, and 90,000 characters landed
 *                                       in `scan_event` — an APPEND-ONLY table
 *                                       on the busiest desk in the school, which
 *                                       this codebase has already sized at tens
 *                                       of millions of rows. There is no scan
 *                                       note that needs more than a sentence.
 *
 * 500 matches the house style for a note field, and the enum comes from
 * `SCAN_PURPOSES` rather than being restated here.
 */
const scanSchema = z.object({
  purpose: z.enum(SCAN_PURPOSES),
  note: z.string().max(500).nullish(),
});

@Controller("members")
@RequireModule(MODULES.CERTIFICATE)
export class MemberScanController {
  constructor(private readonly scan: MemberScanService) {}

  /**
   * Resolve a scanned ID-card code to a member of the caller's OWN school.
   * `member.scan` gated; tenant-scoped (404 across tenants); audited in-service.
   * The code is a path param (opaque uniqueId, no PII), never a body.
   */
  /** One member's movements — the answer to "when did they leave?", which the
   *  product could not give because nothing read scan_event. */
  @Get("scan/history/:memberId")
  @RequirePermission(SIS_PERMISSIONS.MEMBER_SCAN)
  history(
    @CurrentPrincipal() p: Principal,
    @Param("memberId") memberId: string,
    @Query("days") days?: string,
  ): Promise<ScanEventDto[]> {
    return this.scan.history(p, memberId, days ? Number(days) : undefined);
  }

  /** The desk's own day. */
  @Get("scan/today")
  @RequirePermission(SIS_PERMISSIONS.MEMBER_SCAN)
  today(@CurrentPrincipal() p: Principal): Promise<ScanEventDto[]> {
    return this.scan.today(p);
  }

  @Get("scan/:code")
  @RequirePermission(SIS_PERMISSIONS.MEMBER_SCAN)
  resolve(@CurrentPrincipal() p: Principal, @Param("code") code: string): Promise<MemberScanDto> {
    return this.scan.resolve(p, code);
  }

  /**
   * RECORD an action for a scanned member (check-in / check-out / library /
   * exam). CHECK_IN of a student marks them present in today's register.
   * Same tenant-scoping, permission and audit as the lookup.
   */
  @Post("scan/:code")
  @RequirePermission(SIS_PERMISSIONS.MEMBER_SCAN)
  record(
    @CurrentPrincipal() p: Principal,
    @Param("code") code: string,
    @Body(new ZodValidationPipe(scanSchema)) body: z.infer<typeof scanSchema>,
  ): Promise<ScanRecordResultDto> {
    return this.scan.record(p, code, body.purpose, body.note ?? null);
  }
}
