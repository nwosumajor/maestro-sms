// =============================================================================
// MetricsMiddleware — feed the prom-client registry per request
// =============================================================================
// Runs on every route and records to MetricsService on response `finish` (status
// + latency known, and the principal the guard attached is available). Request
// LOGGING is handled separately by nestjs-pino (LoggerModule); this is metrics
// only. The route LABEL is the matched PATTERN, never the raw path, so scanners
// can't explode metric cardinality.
// =============================================================================

import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import type { Principal } from "../auth/principal";
import { MetricsService } from "./metrics.service";

interface ObservedRequest extends Request {
  principal?: Principal;
}

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: ObservedRequest, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req.route?.path as string | undefined) ?? "unmatched";
      this.metrics.observeHttp(req.method, route, res.statusCode, durationSec, req.principal?.schoolId);
    });
    next();
  }
}
