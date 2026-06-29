import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ADMIN_PERMISSIONS } from "@sms/types";
import type { BrandingUploadTargetDto, PublicBrandingDto, SchoolBrandingDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { BrandingService } from "./branding.service";

const uploadSchema = z.object({ contentType: z.enum(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]) });

// Always-on (no @RequireModule): branding is platform-level, not a subscription
// module. The custom logo's VISIBILITY is gated by subscription standing in the
// service, not by a module entitlement.
@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** Principal: request an upload target for the school logo. */
  @Post("schools/branding/logo")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  upload(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
  ): Promise<BrandingUploadTargetDto> {
    return this.branding.getUploadTarget(p, body.contentType);
  }

  @Delete("schools/branding/logo")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  remove(@CurrentPrincipal() p: Principal): Promise<SchoolBrandingDto> {
    return this.branding.removeLogo(p);
  }

  @Get("schools/branding")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  mine(@CurrentPrincipal() p: Principal): Promise<SchoolBrandingDto> {
    return this.branding.getMyBranding(p);
  }

  /** PUBLIC, pre-auth: a school's login-page branding by slug. */
  @Public()
  @Get("public/schools/:slug/branding")
  publicBranding(@Param("slug") slug: string): Promise<PublicBrandingDto> {
    return this.branding.getPublicBranding(slug);
  }
}
