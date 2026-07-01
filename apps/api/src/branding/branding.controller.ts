import { BadRequestException, Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ADMIN_PERMISSIONS } from "@sms/types";
import type { PublicBrandingDto, SchoolBrandingDto } from "@sms/types";
import { z } from "zod";
import { RequirePermission } from "../auth/require-permission.decorator";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { BrandingService } from "./branding.service";

// Logo bytes uploaded directly (base64). PNG/JPEG only — these are what pdfkit can
// embed into the generated certificates / report cards (and it excludes SVG XSS).
const MAX_LOGO_BYTES = 1_000_000; // 1 MB
const uploadSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg"]),
  dataBase64: z.string().min(1).max(2_000_000),
});
const themeSchema = z.object({
  brandHue: z.number().int().min(0).max(360).nullish(),
  brandSat: z.number().int().min(0).max(100).nullish(),
  brandLight: z.number().int().min(0).max(100).nullish(),
  fontFamily: z.string().max(200).nullish(),
});

// Always-on (no @RequireModule): branding is platform-level, not a subscription
// module. The custom logo's VISIBILITY is gated by subscription standing in the
// service, not by a module entitlement.
@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** Principal / school_admin: upload the school logo (appears on the login page
   *  AND on generated certificates + report cards). */
  @Post("schools/branding/logo")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  upload(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(uploadSchema)) body: z.infer<typeof uploadSchema>,
  ): Promise<SchoolBrandingDto> {
    // Strip an optional data-URL prefix, decode, and bound the size.
    const raw = body.dataBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) throw new BadRequestException("Empty or invalid image data");
    if (buffer.length > MAX_LOGO_BYTES) throw new BadRequestException("Logo exceeds the 1 MB limit");
    return this.branding.uploadLogo(p, buffer, body.contentType);
  }

  @Delete("schools/branding/logo")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  remove(@CurrentPrincipal() p: Principal): Promise<SchoolBrandingDto> {
    return this.branding.removeLogo(p);
  }

  /** Set the per-school theme (brand colour + font). */
  @Post("schools/branding/theme")
  @RequirePermission(ADMIN_PERMISSIONS.SCHOOL_BRANDING_MANAGE)
  setTheme(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(themeSchema)) body: z.infer<typeof themeSchema>,
  ): Promise<SchoolBrandingDto> {
    return this.branding.setTheme(p, body);
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
