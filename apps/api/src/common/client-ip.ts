// =============================================================================
// Who is this request actually from?
// =============================================================================
// The rate limiter is only as good as this answer, and it was wrong in two
// opposite directions at once.
//
// (1) SPOOFABLE. It read the FIRST entry of `X-Forwarded-For`. nginx is
//     configured with `$proxy_add_x_forwarded_for`, which APPENDS the real peer
//     to whatever the client sent — so the first entry is whatever the caller
//     typed. Proved by rotating the header: 15 of 15 login attempts got
//     through a limit of 10.
//
// (2) ABSENT. On the deployed path the browser never talks to the API. It talks
//     to the web tier, whose proxies forwarded Authorization, x-stepup and
//     Content-Type and nothing else. So the API saw one peer — the web task —
//     for every request on earth, and the "per-IP" limiter became a per-ROUTE
//     GLOBAL one. Proved through the real path: six password-reset requests
//     from six different client IPs, and the sixth was refused.
//
//     That second one is an availability bug before it is a security one. Ten
//     sign-in attempts a minute across every school, and the eleventh person to
//     try to log in anywhere is turned away.
//
// THE RULE: read the RIGHTMOST entry, not the leftmost.
//
// Each trusted proxy APPENDS the peer it actually observed. An attacker can
// prepend anything they like and cannot append after nginx, so the last entry
// is the only one they do not control. This is the reverse of the usual advice
// ("the first entry is the client") — that advice assumes the header is being
// read at the edge, and this is read behind it.
//
// It follows that the API must never be reachable directly from the internet.
// It is not: private subnets, and REST flows web→api over Cloud Map.
// =============================================================================

export interface IpBearingRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * The client address to rate-limit on.
 *
 * Falls back to the socket peer when no forwarded header is present, which is
 * correct for a direct call (local development, or one service calling another).
 */
export function clientIp(req: IpBearingRequest): string {
  const raw = req.headers?.["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (header) {
    const hops = header
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    // RIGHTMOST — the entry our own proxy appended. See the note above.
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}
