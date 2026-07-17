import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ONBOARDING_CONTACT_ROLES, ONBOARDING_SCHOOL_TYPES } from "@sms/types";
import type { PlanPriceDto, PublicSchoolDto } from "@sms/types";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { PlanPricingService } from "../billing/plan-pricing.service";
import { PublicService } from "./public.service";

const onboardingSchema = z.object({
  schoolName: z.string().min(1).max(160),
  // School profile — REQUIRED sales-qualifying detail (type, location, scale).
  schoolType: z.enum(ONBOARDING_SCHOOL_TYPES),
  address: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  state: z.string().min(1).max(120),
  country: z.string().min(1).max(120),
  website: z.string().max(200).nullish(),
  studentCount: z.number().int().min(1).max(200_000),
  staffCount: z.number().int().min(1).max(50_000),
  // Contact person — phone is required (the review team follows up by call).
  // Proprietor/owner — the business relationship the platform bills. Required:
  // the operator directory keys on it. May be the same person as the contact.
  ownerName: z.string().min(1).max(160),
  ownerPhone: z.string().min(5).max(40),
  contactName: z.string().min(1).max(160),
  contactRole: z.enum(ONBOARDING_CONTACT_ROLES),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(5).max(40),
  desiredSlug: z.string().max(40).nullish(),
  // Requested tier + add-on modules (wish-only; service re-validates against the
  // real plan/module keys and drops anything unknown).
  desiredPlan: z.string().max(20).nullish(),
  desiredModules: z.array(z.string().max(30)).max(30).nullish(),
  currentSystem: z.string().max(300).nullish(),
  referralCode: z.string().max(40).nullish(),
  agentCode: z.string().max(40).nullish(),
  // Clickwrap: the requester must tick acceptance of the MSA/DPA/Privacy pack.
  legalAccepted: z.literal(true),
  notes: z.string().max(2000).nullish(),
});
const inviteSchema = z.object({
  token: z.string().min(20).max(2000),
  password: z.string().min(8).max(200),
});
const resetRequestSchema = z.object({ email: z.string().email().max(200) });

// Entirely public (pre-auth) website surface. Rate-limit at the edge in prod.
@Controller("public")
export class PublicController {
  constructor(
    private readonly publicSvc: PublicService,
    private readonly pricing: PlanPricingService,
  ) {}

  /** PUBLIC: the directory of onboarded schools (parents browse + apply). */
  @Public()
  @Get("schools")
  schools(): Promise<PublicSchoolDto[]> {
    return this.publicSvc.listSchools();
  }

  /** PUBLIC: effective plan-tier pricing for the landing page — the SAME
   *  operator-overridable prices checkout charges, so the marketing page can
   *  never drift from the real bill. No tenant data; service-side cached. */
  @Public()
  @Get("plan-pricing")
  planPricing(): Promise<PlanPriceDto[]> {
    return this.pricing.list();
  }

  /** PUBLIC: a prospective principal requests to onboard their school. Rate-limited
   *  (in-process backstop to the edge WAF) — unauthenticated write. */
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("onboarding-requests")
  onboard(@Body(new ZodValidationPipe(onboardingSchema)) body: z.infer<typeof onboardingSchema>) {
    return this.publicSvc.submitOnboardingRequest(body);
  }

  /** PUBLIC: accept a provisioning invite (set the account's first password).
   *  Signed single-use token; tightly rate-limited (credential-setting surface). */
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("invite/accept")
  acceptInvite(@Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    return this.publicSvc.acceptInvite(body.token, body.password);
  }

  /** PUBLIC: request a forgot-password reset email. Always 200 (no oracle);
   *  tightly rate-limited — this endpoint can trigger outbound email. */
  @Public()
  @UseGuards(new RateLimitGuard(5, 60_000))
  @Post("password-reset/request")
  requestReset(@Body(new ZodValidationPipe(resetRequestSchema)) body: z.infer<typeof resetRequestSchema>) {
    return this.publicSvc.requestPasswordReset(body.email);
  }

  /** PUBLIC: apply a forgot-password reset (single-use signed token). */
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("password-reset/confirm")
  confirmReset(@Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    return this.publicSvc.confirmPasswordReset(body.token, body.password);
  }
}
