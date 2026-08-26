// =============================================================================
// A tenant's data is not somebody else's cache entry
// =============================================================================
// Every authenticated response this API produces went out with NO
// `Cache-Control` header at all, and a `Vary` naming only Next's RSC headers —
// not `Cookie`. Measured on the running stack: `/students`, `/invoices`,
// `/notifications`, `/analytics/overview` and `/hr/employees` all answered 200
// with `cache-control: null`.
//
// A 200 GET with no freshness information is HEURISTICALLY CACHEABLE by a
// shared cache (RFC 9111 §4.2.2). Nothing in this deployment does so —
// CloudFront runs `Managed-CachingDisabled` and the shipped nginx has no
// `proxy_cache`, both checked — so this is LATENT rather than live at the edge.
// What it is NOT latent for is everything past the edge, which this platform
// does not own:
//
//   * a SCHOOL'S OWN proxy, keyed on URL alone because nothing said `Vary:
//     Cookie`, serving one teacher's `/students` to the next;
//   * the browser's disk cache and back-button after sign-out, on a device this
//     product is designed to SHARE — the `/scan` gate desk with its
//     always-focused scanner input, and the attendance kiosk.
//
// Golden Rule #7: unsure, choose the more restrictive option. Nothing is lost
// by it today, because nothing is caching today.
//
// THE PUBLIC SURFACE IS INCLUDED HERE AND DELIBERATELY NOT PROPAGATED.
//
// This middleware is the restrictive default at the source, which is right for
// any consumer that reaches the API directly. But `/api/public/*` has its own
// proxy in the web tier, and that one rebuilds headers too and does NOT carry
// this one across — checked live: `/api/public/plan-pricing` answers with no
// `Cache-Control` at all. That is a decision, not an oversight: the public
// surface is the school directory, plan pricing and vacancy listings, none of
// it personal and all of it identical for every caller, so it is the one thing
// here a CDN could usefully cache one day.
//
// Said out loud because the alternative is a comment claiming coverage the
// running system does not give — the failure this repo keeps finding in its own
// notes.
// =============================================================================

import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";

/** Scrapes, not tenant data — and Prometheus is happy either way. */
const UNGUARDED = new Set(["/metrics", "/health"]);

@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (!UNGUARDED.has(req.path)) {
      res.setHeader("Cache-Control", "private, no-store");
      // Belt and braces for a cache that ignores `no-store` but honours a key:
      // without this, a URL is the whole key and two sessions collide.
      res.setHeader("Vary", "Cookie, Authorization");
    }
    next();
  }
}
