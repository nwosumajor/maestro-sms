import { SetMetadata } from "@nestjs/common";

export const STEPUP_KEY = "sms:require_stepup";

/**
 * Mark a route as requiring a fresh step-up re-authentication (an `x-stepup`
 * token from POST /security/stepup), on TOP of the normal permission. Used for
 * the most sensitive actions (medical edits, MFA disable, bulk export).
 */
export const RequireStepUp = () => SetMetadata(STEPUP_KEY, true);
