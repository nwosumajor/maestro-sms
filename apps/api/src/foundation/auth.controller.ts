import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "../integrity/integrity.foundation";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { AuthService } from "./auth.service";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().optional(),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

/**
 * Stateless credential verification. Auth.js (web) owns the session and calls
 * this to validate a login and fetch the user's tenant + authz claims, which it
 * then stamps onto the signed JWT. Public: it IS the authentication step.
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // SECURITY: unauthenticated + writes lockout state, so it MUST be throttled —
  // otherwise the 3-strike permanent lock is a mass account-lockout DoS (spray 3
  // wrong passwords per known email, unthrottled). Per-IP in-process backstop;
  // the edge WAF rate rule remains the primary control (same posture as /apply).
  @Public()
  @UseGuards(new RateLimitGuard(10, 60_000))
  @Post("login")
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginSchema))
    body: { email: string; password: string; mfaCode?: string },
  ) {
    return this.auth.login(body.email, body.password, body.mfaCode);
  }

  /** Change your own password (voluntary, or to satisfy the forced 30-day reset).
   *  Authenticated — the session identifies the user; no permission needed. */
  @Post("change-password")
  @HttpCode(200)
  async changePassword(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    await this.auth.changePassword(p.userId, p.schoolId, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}
