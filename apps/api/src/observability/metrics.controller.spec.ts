import { ForbiddenException } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

// The /metrics endpoint is @Public (a scraper has no JWT) but optionally gated by
// a shared token. These tests pin that gate: open when unset, enforced when set.
describe("MetricsController", () => {
  const saved = process.env.METRICS_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = saved;
  });

  it("is open when METRICS_TOKEN is unset (local/dev)", async () => {
    delete process.env.METRICS_TOKEN;
    const c = new MetricsController(new MetricsService());
    expect(await c.scrape()).toContain("# TYPE http_requests_total counter");
  });

  it("requires the token when METRICS_TOKEN is set", async () => {
    process.env.METRICS_TOKEN = "s3cret";
    const c = new MetricsController(new MetricsService());
    expect(() => c.scrape("Bearer wrong")).toThrow(ForbiddenException);
    expect(() => c.scrape(undefined, undefined)).toThrow(ForbiddenException);
    expect(await c.scrape("Bearer s3cret")).toContain("process_cpu_seconds_total");
    // also accepts the x-metrics-token header
    expect(await c.scrape(undefined, "s3cret")).toContain("process_cpu_seconds_total");
  });
});
