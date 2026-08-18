import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { verifyDocumentUploadToken, type UploadTokenSubject } from "./document-upload-token";
import { SuppliedDocumentsService } from "./supplied-documents.service";

const startSchema = z.object({
  requirementId: z.string().uuid().nullish(),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
});

/**
 * The family's own surface: an unauthenticated write endpoint on the internet
 * that accepts files. Everything here is shaped by that.
 *
 * THE TOKEN IS THE ONLY CREDENTIAL, and it decides the subject. No route takes
 * an application id — the id comes out of the signature, so a valid link for one
 * child can never be pointed at another, in the same way school_id is only ever
 * read from a verified JWT.
 *
 * NOTHING HERE SERVES BYTES. A family can see that a file arrived and what the
 * school made of it; reading a document back happens only on the authenticated,
 * audited staff route. A leaked link must not publish a child's birth
 * certificate — that is the single property this surface is designed around.
 *
 * DELIBERATELY NOT @RequireModule. The link goes out by email and a school that
 * later loses the documents module would leave families holding URLs that answer
 * 404 with no explanation. The endpoints stay reachable and the school simply
 * asks for nothing.
 *
 * Rate limits are per IP and per route. They bound noise, not a determined
 * attacker holding a valid token — the submission cap in the service is what
 * bounds that.
 */
@Controller("public/documents")
export class PublicDocumentsController {
  constructor(private readonly supplied: SuppliedDocumentsService) {}

  /** One answer for every bad token: expired, forged, wrong purpose, or for an
   *  application that no longer takes documents. Which one it was is
   *  information, and the person asking is unauthenticated. */
  private subjectOf(token: string | undefined): UploadTokenSubject {
    const subject = verifyDocumentUploadToken(token);
    if (!subject) throw new BadRequestException("This link is not valid or has expired. Ask the school for a new one.");
    return subject;
  }

  @Public()
  @UseGuards(new RateLimitGuard(30, 60_000))
  @Get("checklist")
  checklist(@Query("token") token?: string) {
    return this.supplied.publicChecklist(this.subjectOf(token));
  }

  @Public()
  @UseGuards(new RateLimitGuard(20, 60_000))
  @Post("upload-url")
  startUpload(
    @Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>,
    @Query("token") token?: string,
  ) {
    return this.supplied.publicStartUpload(this.subjectOf(token), body);
  }

  @Public()
  @UseGuards(new RateLimitGuard(20, 60_000))
  @Post(":id/confirm")
  confirm(@Param("id") id: string, @Query("token") token?: string) {
    return this.supplied.publicConfirm(this.subjectOf(token), id);
  }
}
