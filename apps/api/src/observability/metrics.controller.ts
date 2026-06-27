// =============================================================================
// MetricsController — Prometheus scrape endpoint (GET /metrics)
// =============================================================================
// @Public so it bypasses the JWT guard (a scraper has no session), but optionally
// gated by a shared token: if METRICS_TOKEN is set, the scraper must present it as
// `Authorization: Bearer <token>` or `x-metrics-token`. Unset => open (local/dev).
// In the cloud, expose this only inside the VPC (the ALB's /metrics path is not
// forwarded by CloudFront) and set METRICS_TOKEN for defence in depth.
// =============================================================================

import { Controller, ForbiddenException, Get, Header, Headers } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  scrape(
    @Headers("authorization") auth?: string,
    @Headers("x-metrics-token") tokenHeader?: string,
  ): Promise<string> {
    const required = process.env.METRICS_TOKEN;
    if (!required) {
      // Open only in non-production. In production an unset token fails CLOSED, so
      // /metrics is never inadvertently exposed without authentication.
      if (process.env.NODE_ENV === "production") throw new ForbiddenException();
      return this.metrics.render();
    }
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const presented = bearer ?? tokenHeader;
    if (presented !== required) throw new ForbiddenException();
    return this.metrics.render();
  }
}
