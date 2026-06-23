import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().optional(),
});

/**
 * Stateless credential verification. Auth.js (web) owns the session and calls
 * this to validate a login and fetch the user's tenant + authz claims, which it
 * then stamps onto the signed JWT. Public: it IS the authentication step.
 */
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginSchema))
    body: { email: string; password: string; mfaCode?: string },
  ) {
    return this.auth.login(body.email, body.password, body.mfaCode);
  }
}
