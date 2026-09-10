// =============================================================================
// The one place the web tier learns where the API is
// =============================================================================
// `process.env.API_BASE_URL ?? "http://localhost:3001"` was written out in
// SIXTEEN files. Both halves of that are a problem.
//
// The rule written sixteen times is right sixteen times only until it is not,
// and there is no way to change it once — the shape this repo records over and
// over. So it lives here, and the call sites ask.
//
// And the fallback is silent. `??` is blind to an EMPTY STRING, so
// `API_BASE_URL=""` — a mistyped secret name, a missing task-definition entry,
// a deploy outside the Terraform that sets it — passes straight through and the
// web tier asks `http://localhost:3001` from inside its own container. Nothing
// is listening there, so every server-rendered page comes back BLANK, with no
// error naming the cause and nothing in the logs pointing at a variable. That is
// precisely the case Golden-Rule-adjacent operational safety already names:
// fail closed at BOOT where a mis-set value is unrecoverable afterwards.
//
// PRODUCTION FAILS CLOSED; local work keeps the localhost default, the same
// split `assertFieldCryptoConfigured` makes in the API tier and for the same
// reason — the protection is for the deployment, not for the developer.
//
// LAZY, not module-level. `next build` runs with NODE_ENV=production, so a check
// that threw at import time would fail the Docker build, where the variable is
// legitimately absent because it is a RUNTIME concern. Validating on use means
// the only thing that can trip it is a real request on a real deployment.
// =============================================================================

/** What a deployment must set, so the message can name it exactly once. */
const VAR = "API_BASE_URL";

/**
 * Where the API lives, for server-side calls from the web tier.
 *
 * @throws in production when the variable is missing, empty, or not an
 * absolute http(s) URL — rather than quietly addressing localhost.
 */
export function apiBaseUrl(): string {
  const raw = process.env[VAR]?.trim();

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${VAR} is not set. Refusing to serve: every server-rendered page would ask ` +
          `http://localhost:3001 from inside this container, find nothing listening, and come back ` +
          `blank with no error naming the cause. Set it to the API's internal address — the ECS ` +
          `task definition uses the Cloud Map DNS, and docker-compose uses http://backend:3001.`,
      );
    }
    // Local development, where the API really is on localhost.
    return "http://localhost:3001";
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${VAR} is not a URL (got "${raw}"). It must be absolute, like http://backend:3001 — ` +
        `a bare host or a path silently becomes a relative fetch that resolves to nowhere.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${VAR} must be http or https (got "${url.protocol}" in "${raw}").`);
  }

  // Callers write `${apiBaseUrl()}/path`, so a trailing slash would produce a
  // double one. Harmless on most servers and a 404 on some; normalise it here
  // rather than leaving sixteen call sites to each get it right.
  return raw.replace(/\/+$/, "");
}
