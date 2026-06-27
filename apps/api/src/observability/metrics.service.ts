// =============================================================================
// MetricsService — Prometheus metrics on prom-client
// =============================================================================
// Owns a dedicated prom-client Registry: the default Node.js process metrics
// (CPU, memory, GC, event-loop lag, open fds) plus our HTTP series. Labels are
// kept LOW-CARDINALITY: the route is the matched PATTERN (/invoices/:id), never
// the raw path, so a scanner hitting /invoices/<random> can't explode the series.
// Per-tenant volume is a separate counter keyed on school_id (bounded ~50).
//
// Each task exposes its own series at GET /metrics; Prometheus scrapes + aggregates
// across instances (the standard model). Counters reset on restart (handled by
// Prometheus rate()).
// =============================================================================

import { Injectable } from "@nestjs/common";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly httpTotal: Counter<"method" | "route" | "status">;
  private readonly httpDuration: Histogram<"method" | "route">;
  private readonly tenantTotal: Counter<"school_id">;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpTotal = new Counter({
      name: "http_requests_total",
      help: "Total HTTP requests by method, route and status.",
      labelNames: ["method", "route", "status"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency by method and route.",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.tenantTotal = new Counter({
      name: "tenant_requests_total",
      help: "Total HTTP requests per tenant (school).",
      labelNames: ["school_id"],
      registers: [this.registry],
    });
  }

  /** Record one finished HTTP request. durationSec in seconds. */
  observeHttp(method: string, route: string, status: number, durationSec: number, schoolId?: string): void {
    this.httpTotal.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, durationSec);
    if (schoolId) this.tenantTotal.inc({ school_id: schoolId });
  }

  /** Prometheus text exposition for the whole registry. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  /** The exposition content-type (incl. version), for the scrape response. */
  contentType(): string {
    return this.registry.contentType;
  }
}
