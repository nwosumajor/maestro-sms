import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import type { PublicSchoolDto } from "@sms/types";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { PublicService } from "./public.service";

const onboardingSchema = z.object({
  schoolName: z.string().min(1).max(160),
  contactName: z.string().min(1).max(160),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(40).nullish(),
  desiredSlug: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
});

// Entirely public (pre-auth) website surface. Rate-limit at the edge in prod.
@Controller("public")
export class PublicController {
  constructor(private readonly publicSvc: PublicService) {}

  /** PUBLIC: the directory of onboarded schools (parents browse + apply). */
  @Public()
  @Get("schools")
  schools(): Promise<PublicSchoolDto[]> {
    return this.publicSvc.listSchools();
  }

  /** PUBLIC: a prospective principal requests to onboard their school. Rate-limited
   *  (in-process backstop to the edge WAF) — unauthenticated write. */
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("onboarding-requests")
  onboard(@Body(new ZodValidationPipe(onboardingSchema)) body: z.infer<typeof onboardingSchema>) {
    return this.publicSvc.submitOnboardingRequest(body);
  }
}
