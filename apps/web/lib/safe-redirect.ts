// =============================================================================
// Where a redirect is allowed to send somebody — ONE definition
// =============================================================================
// The only user-controlled redirect target in this app is `?next=`, carried by
// the middleware when it interrupts a request and consumed by /login once the
// user signs in. It was validated in THREE places with the same hand-rolled
// pair of conditions:
//
//     next.startsWith("/") && !next.startsWith("//")
//
// (middleware.ts, login/page.tsx's `safeNext`, LoginForm's `dest`). That check
// stops the obvious protocol-relative form and MISSES THE BACKSLASH FAMILY,
// because browsers normalise `\` to `/` inside a URL before resolving it — so
// `/\evil.com` is delivered as a path, normalised to `//evil.com`, and resolved
// as protocol-relative to another origin.
//
// MEASURED against the running stack, signed in, reading the `Location` header:
//
//     next=//evil.example.com        -> /dashboard                  blocked
//     next=https://evil.example.com  -> /dashboard                  blocked
//     next=/\evil.example.com        -> /\evil.example.com          SENT
//     next=/%5Cevil.example.com      -> /%5Cevil.example.com        SENT
//     next=/\/evil.example.com       -> /\/evil.example.com         SENT
//
// That is an open redirect on the sign-in page: a link to this application's
// real login URL that deposits the user on an attacker's page immediately after
// they authenticate, which is the exact shape credential-phishing wants — the
// victim checks the domain, sees ours, and is handed off afterwards.
//
// THE RULE IS A DESTINATION ALLOWLIST, NOT A PREFIX TEST. A same-origin path is
// allowed; an absolute URL is allowed only when its host is one of this
// deployment's own, and anything else becomes the fallback. Written once so the
// next door cannot disagree, and gated by `a-redirect-that-leaves-our-domain`.
// =============================================================================

/** Where to send somebody when the requested destination is not allowed. */
export const DEFAULT_REDIRECT = "/dashboard";

/**
 * This deployment's own hosts.
 *
 * `PUBLIC_WEB_URL` is the canonical one and is already required at boot, so the
 * list is never empty in a real environment. `REDIRECT_ALLOWED_HOSTS` is the
 * comma-separated escape hatch for a deployment that genuinely answers on more
 * than one name — a vanity domain, a marketing host, a staging alias.
 *
 * Hosts are compared WITHOUT the port and case-insensitively, and a leading
 * `*.` means "this domain and its subdomains" — never a bare suffix match,
 * which would make `notmyschool.com` a match for `myschool.com`.
 */
export function allowedRedirectHosts(): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    for (const part of (raw ?? "").split(",")) {
      const v = part.trim().toLowerCase();
      if (!v) continue;
      // Accept either a bare host or a full URL, so the same variable can be
      // pasted from either place without a second format to remember.
      try {
        out.push(v.includes("://") ? new URL(v).hostname : new URL(`https://${v}`).hostname);
      } catch {
        /* a malformed entry is ignored rather than widening the list */
      }
    }
  };
  add(process.env.PUBLIC_WEB_URL);
  add(process.env.NEXT_PUBLIC_WEB_URL);
  add(process.env.REDIRECT_ALLOWED_HOSTS);
  // IN THE BROWSER, the page's own origin IS one of our domains, by definition
  // — and `PUBLIC_WEB_URL` is server-only, so without this the same URL would
  // be accepted by the server and refused by the client island that re-checks
  // it. The divergence fails closed, which is the safe direction and still a
  // disagreement between two halves of one rule.
  if (typeof window !== "undefined" && window.location?.hostname) {
    out.push(window.location.hostname.toLowerCase());
  }
  return [...new Set(out)];
}

/** Does this host belong to us? `*.example.com` covers example.com and its subdomains. */
function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    if (a.startsWith("*.")) {
      const root = a.slice(2);
      return h === root || h.endsWith(`.${root}`);
    }
    return h === a;
  });
}

/**
 * Is this a SAME-ORIGIN PATH, and nothing cleverer?
 *
 * Everything here is a way of writing "somewhere else" that a naive prefix test
 * reads as a path:
 *   - control characters, which browsers STRIP before parsing, so `/\tevil` and
 *     `/\nevil` reach the network as something other than what was checked;
 *   - a second character of `/` or `\` in any encoding, which makes the rest an
 *     authority rather than a path;
 *   - a backslash anywhere in the first segment, normalised to `/` on the way
 *     out;
 *   - a scheme, because `javascript:` and `data:` are not navigation to a page.
 */
function isSameOriginPath(raw: string): boolean {
  // Browsers drop these entirely, so the string that is CHECKED and the string
  // that is RESOLVED differ unless they are refused outright.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  if (!raw.startsWith("/")) return false;

  // Decode once so `%5C` (backslash) and `%2F` (slash) cannot smuggle an
  // authority past a check written against the literal characters. A string
  // that will not decode is refused rather than guessed at.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return false;

  for (const candidate of [raw, decoded]) {
    // `//host`, `/\host`, `/\/host` — anything whose SECOND character opens an
    // authority section.
    if (/^[/\\]{2}/.test(candidate)) return false;
    if (!candidate.startsWith("/")) return false;
    // A backslash before the first `/` boundary is normalised into one, which
    // is how `/\evil.com` becomes `//evil.com`.
    const firstSegment = candidate.slice(1).split("/")[0];
    if (firstSegment.includes("\\")) return false;
    // A scheme is never a path. `:` is legal later in a path (a matrix param,
    // an encoded id), so this only looks at the first segment.
    if (firstSegment.includes(":")) return false;
  }
  return true;
}

/**
 * The destination to actually send somebody to.
 *
 * Returns a same-origin path unchanged, returns an absolute URL only when it
 * points at one of OUR hosts, and otherwise returns `fallback`. It never
 * throws and never returns the caller's string unvalidated, so a caller cannot
 * use it and still get this wrong.
 */
export function safeRedirect(candidate: string | null | undefined, fallback = DEFAULT_REDIRECT): string {
  if (typeof candidate !== "string") return fallback;
  const value = candidate.trim();
  if (!value) return fallback;

  if (isSameOriginPath(value)) return value;

  // An ABSOLUTE url is allowed only if we own the host. This is the half the
  // brief asked for: a list of our own domains, not a shape test.
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (hostAllowed(url.hostname, allowedRedirectHosts())) return url.toString();
    } catch {
      /* unparseable -> fallback */
    }
  }
  return fallback;
}

/**
 * The same decision, as a boolean, for the one caller that needs to decide
 * whether to ATTACH a `next` rather than where to go (the middleware). Sharing
 * the predicate is the point: a separate spelling there is how the three copies
 * this replaces came to exist.
 */
export function isSafeRedirect(candidate: string | null | undefined): boolean {
  return typeof candidate === "string" && candidate.trim() !== "" && safeRedirect(candidate, "\u0000") !== "\u0000";
}
