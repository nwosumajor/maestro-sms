// =============================================================================
// Secrets that are already public, because this repository printed them
// =============================================================================
// Validating a secret's SHAPE is not validating a secret. `.env.example` shipped
//
//   DATA_ENCRYPTION_KEY=Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=
//
// which is a perfectly well-formed 32-byte base64 key — it passes every check
// added for malformed keys — and is published in this repository. A deployment
// that copied the example encrypts every medical record, salary, payslip and
// bank detail with a key anyone can read from the source. The ciphertext is
// real; the protection is not. Measured on this machine: 13 salary rows and 1
// medical record encrypted with exactly that key.
//
// AUTH_SECRET had the same problem in a cruder form (`change-me-32-char-min-
// secret`), and a pattern match caught it. This one no pattern would catch,
// because it looks exactly like what it should be. The only thing that
// distinguishes it is that we published it.
//
// So the check is PROVENANCE, not shape: these exact strings have appeared in
// the repository's history and can never be a secret again, whatever they look
// like. `published-secrets.spec.ts` reads `.env.example` and fails if it grows
// another secret-looking value that is not registered here — so the list cannot
// silently fall behind the file that creates the problem.
// =============================================================================

/**
 * Every secret value this repository has ever shipped in an example file.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST. A value stays compromised after the
 * example stops carrying it — deployments that copied it still have it, which is
 * precisely who this protects.
 */
export const PUBLISHED_SECRETS: readonly string[] = [
  // infrastructure/.env.example, until 2026-08-23
  "change-me-32-char-min-secret",
  "Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=",
  "change-me-superuser",
  "change-me-app",
];

/** Has this value been published? Exact match — a secret is one string. */
export function isPublishedSecret(value: string | undefined): boolean {
  return !!value && PUBLISHED_SECRETS.includes(value.trim());
}
