/**
 * Deadlines for outbound calls to other people's servers.
 *
 * Node's `fetch` has NO default timeout. A gateway that refuses the connection
 * throws and is handled everywhere in this codebase; a gateway that ACCEPTS the
 * connection and then never answers — the commoner failure under load — is
 * awaited for ever. That distinction is the whole point of this file, because
 * every one of these calls is made from a worker whose queue runs ONE job at a
 * time: a single hung request does not fail, so it is never retried, never
 * logged and never alerted, and it holds that queue's only slot until the
 * process restarts.
 *
 * What that cost, concretely, before this existed:
 *   - the mobile-money RECOVERY sweep is the only thing that closes a payment
 *     whose callback was lost (the rails are unsigned, deliver once and never
 *     retry). Its per-intent poll is wrapped in a catch commented "one rail
 *     being down must not stop the sweep for the others" — which a hang walks
 *     straight past, stranding every payer in the batch, including those on
 *     rails that were perfectly healthy;
 *   - notification delivery would stop entirely — receipts, absence alerts, the
 *     lot — on one unresponsive email provider;
 *   - dunning would stop charging saved cards mid-sweep.
 *
 * A timeout on a money call is not free: a charge that is cut off at the
 * deadline is genuinely ambiguous. It is still the right trade, because every
 * settlement path is idempotent on the gateway reference and the sweeps re-ask,
 * so an ambiguous answer is recoverable and an infinite wait is not.
 */
export const GATEWAY_TIMEOUT_MS = 15_000;

/**
 * `fetch` with a deadline. Use this for every call that leaves the building.
 *
 * It exists because a shared default is the only thing that holds: the two
 * gateways that hand-rolled their options gave a 10-second deadline to
 * `/balance`, a diagnostic nobody's money depends on, and none at all to
 * `transaction/initialize`, `verify`, `refund` or `charge_authorization`. That
 * is not a decision anyone made — it is what happens when each call site is
 * written on its own.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms: number = GATEWAY_TIMEOUT_MS,
): Promise<Response> {
  // An explicit signal wins — a caller with its own deadline knows better.
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}
