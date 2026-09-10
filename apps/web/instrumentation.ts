// =============================================================================
// Refuse to SERVE a web tier that does not know where the API is
// =============================================================================
// `apiBaseUrl()` throws on a missing or malformed API_BASE_URL, and that alone
// is NOT a fail-closed check — because every caller is inside a try/catch that
// exists for a good reason. `/schools` is the proof: with the variable unset it
// answered **200**, rendered its shell, and told a prospective parent
//
//     "We couldn't load the school list just now ... refresh in a moment"
//
// which is a condition that will never clear, on the page whose entire job is
// to show that this platform has schools. Nothing in the container log named
// API_BASE_URL, ECONNREFUSED, or localhost:3001. A misconfigured deploy looked
// like a slow afternoon.
//
// So the check runs HERE, once, when the server bootstraps — before a request
// can reach a handler that would swallow it. The container dies at startup with
// the variable's name in the log, ECS reports an unhealthy task, and the deploy
// fails instead of succeeding into a broken site. That is the difference the
// operational-safety rule is asking for: loud at boot, where a mis-set value is
// unrecoverable afterwards.
//
// The lazy throw in `apiBaseUrl()` STAYS as the second layer, for the same
// reason isolation is enforced at three: a value that changes after boot, or a
// runtime that skipped instrumentation, still cannot silently address localhost.
// =============================================================================

export async function register() {
  // Instrumentation also runs on the edge runtime, which does not serve these
  // pages and has no such variable to check.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { apiBaseUrl } = await import("./lib/env");
  try {
    apiBaseUrl();
  } catch (err) {
    // THROWING IS NOT ENOUGH EITHER. Next catches an instrumentation failure,
    // prints "Failed to prepare server" and then prints "Ready" and serves the
    // site anyway — measured, exactly that sequence. That is the same broken
    // deployment with one more line in a log nobody is reading yet.
    //
    // So exit. A non-zero exit is the signal every orchestrator already
    // understands: the ECS task fails its health check, the deploy rolls back,
    // and the reason is the last line in the task log.
    console.error(`[boot] ${(err as Error).message}`);
    process.exit(1);
  }
}
