// =============================================================================
// PUBLIC: check a report card against the school that issued it
// =============================================================================
// The audience is whoever is holding the card and was not party to issuing it —
// a receiving school, an employer, a parent sent a page by someone else. So this
// is unauthenticated by design, and everything about it is shaped by that.
//
// NO CROSS-TENANT READ. The URL carries the school's slug, so the service
// resolves the school from the RLS-exempt registry FIRST and then runs the
// lookup under that school's GUC. An unauthenticated caller is confined by
// exactly the policy a member of staff is. The alternative — a privileged client
// on an internet-facing route — would have handed a public endpoint more reach
// than the app role itself has.
//
// DELIBERATELY NOT @RequireModule. A card already in someone's hands must not
// stop verifying because the school's subscription changed; the document was
// genuine when it was issued and that does not expire.
//
// ONE ANSWER FOR EVERY MISS. Unknown school, unknown code, or a code belonging
// to a different school all return the same 404, so a verifier who mistypes
// cannot learn which half they got right — the 404-not-403 rule applied to an
// audience with no identity at all.
// =============================================================================
import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import type { ReportCardAttestationDto } from "@sms/types";
import { ReportCardAttestationService } from "./report-card-attestation.service";

@Controller("public/report-card")
export class PublicAttestationController {
  constructor(private readonly attestations: ReportCardAttestationService) {}

  /**
   * The code is 60 bits, so the limit is not what makes guessing hopeless — it
   * bounds noise and keeps one scanner from becoming a load source. The
   * unguessable code is the actual control.
   */
  @Public()
  @Get("verify/:slug/:code")
  @UseGuards(new RateLimitGuard(30, 60_000))
  verify(@Param("slug") slug: string, @Param("code") code: string): Promise<ReportCardAttestationDto> {
    return this.attestations.verify(slug, code);
  }
}
