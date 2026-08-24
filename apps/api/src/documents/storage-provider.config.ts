// =============================================================================
// Which storage backs this deployment — decided ONCE
// =============================================================================
// `usingS3()` was written out longhand in NINE
// places: eight module bindings and the conditional registration of the
// development upload controller. They agreed, and nothing made them agree — the
// same shape this codebase collapses into one function everywhere else it
// matters (`holdersOf`, `activeGrantPermissions`, `canDecideWorkflowNow`,
// `assertReleasable`).
//
// Drift here is not cosmetic. If one copy disagreed, a module's files would go
// to a different store than its metadata assumes; and the dev upload route is
// registered by the ninth copy, so a disagreement mounts an unauthenticated
// write endpoint in production.
//
// // SECURITY: it also FAILED OPEN. A value that is not exactly "s3" selected the
// STUB — so `STORAGE_PROVIDER=S3`, a trailing space, or a future `r2` would have
// written every upload to the container's local disk, where it works in testing,
// survives no redeploy, and is gone by the time a family asks for the document.
// Nothing would have said so. An unrecognised value now REFUSES TO BOOT, which
// is the more restrictive option and the one that gets noticed (Golden Rule #7).
// =============================================================================

import { envOrNull } from "../common/env";

/** Values this platform understands. Unset means the local stub, as documented. */
const KNOWN = new Set(["s3", "stub", "local", ""]);

/**
 * Is object storage backed by a real bucket?
 *
 * Normalised, because `S3` and `s3 ` are plainly the same intent and treating
 * them as "not s3" is how uploads end up on a disposable disk.
 */
export function usingS3(): boolean {
  return normalised() === "s3";
}

function normalised(): string {
  return (envOrNull("STORAGE_PROVIDER") ?? "").toLowerCase();
}

/**
 * Refuse to start on a storage provider nobody implemented.
 *
 * Called once at boot. Throwing here costs a failed deploy; the alternative
 * costs a term of documents written to a container filesystem, which nobody
 * discovers until the redeploy that removes them.
 */
export function assertStorageProviderConfigured(): void {
  const value = normalised();
  if (!KNOWN.has(value)) {
    throw new Error(
      `STORAGE_PROVIDER="${process.env.STORAGE_PROVIDER}" is not a provider this platform has. ` +
        `Use "s3" for a real bucket, or leave it unset for the local stub. Refusing to start: an ` +
        `unrecognised value would silently write every upload to the container's own disk.`,
    );
  }
}
