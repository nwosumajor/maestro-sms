// =============================================================================
// An environment variable set to an empty string is NOT set
// =============================================================================
// `process.env.X ?? fallback` is blind to `""`. Nullish coalescing was chosen
// all over this codebase because it is the careful operator — it does not treat
// `0` or `false` as absent — and for env vars, which are always strings, that
// carefulness is exactly wrong: the one falsy value a variable CAN hold is the
// empty string, and it means "not configured".
//
// This is not hypothetical. Seven variables reach the ECS tasks from Terraform
// variables whose declared default is `""` — EMAIL_FROM, EMAIL_PROVIDER,
// SENTRY_DSN, SMS_PROVIDER, TWILIO_ACCOUNT_SID, TWILIO_FROM and
// TWILIO_WHATSAPP_FROM. A deployment that simply does not set one gets the empty
// string, not an absent variable, and every `??` fallback behind it silently
// fails to fire.
//
// Most reads happen to be safe: `if (process.env.SENTRY_DSN)` and
// `SMS_PROVIDER === "twilio"` both treat `""` correctly. Two were not, and both
// were on the path to a real person's inbox or telephone.
//
// Use `envOrNull` for anything read out of the environment as a VALUE. The
// truthy checks are fine as they are; this is for the fallbacks.
// =============================================================================

/** The variable's value, or null if it is unset OR blank. Trimmed. */
export function envOrNull(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The variable's value, or the fallback if it is unset, blank or whitespace. */
export function envOr(name: string, fallback: string): string {
  return envOrNull(name) ?? fallback;
}

/** Is this variable set to a usable value? */
export function envIsSet(name: string): boolean {
  return envOrNull(name) !== null;
}
