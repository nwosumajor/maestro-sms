// =============================================================================
// RateLimitGuard — lightweight per-IP, per-route sliding-window limiter
// =============================================================================
// Defence-in-depth for UNAUTHENTICATED public write intake (admissions /
// onboarding requests). The primary control is the edge WAF/CloudFront rate rule;
// this is an in-process backstop so a single task can't be trivially flooded if
// the edge rule is missing or bypassed.
//
// In-memory by design: per-task counters (no Redis dependency on the public path).
// On multi-task Fargate each task enforces its own window — still meaningfully
// caps abuse, and the edge rule provides the global ceiling. 429 on breach.
// =============================================================================

import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      ip?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, string | string[] | undefined>;
      route?: { path?: string };
      method?: string;
    }>();
    // Trust the platform's forwarded client IP first (ALB/CloudFront), then peer.
    const xff = req.headers?.["x-forwarded-for"];
    const fwd = Array.isArray(xff) ? xff[0] : xff?.split(",")[0]?.trim();
    const ip = fwd || req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${req.method ?? ""}:${req.route?.path ?? ""}:${ip}`;

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      throw new HttpException("Too many requests — please try again shortly.", HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);

    // Opportunistic cleanup so idle keys don't accumulate unbounded.
    if (this.hits.size > 10_000) {
      for (const [k, ts] of this.hits) {
        if (ts.every((t) => t <= cutoff)) this.hits.delete(k);
      }
    }
    return true;
  }
}
