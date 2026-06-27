import { Test } from "@nestjs/testing";
import { Logger } from "nestjs-pino";
import { ObservabilityModule } from "./observability.module";
import { MetricsService } from "./metrics.service";

// Boot the observability wiring in isolation: this compiles LoggerModule.forRoot
// (nestjs-pino), the prom-client MetricsService, and the global error interceptor,
// catching any DI/config misconfiguration the pure unit tests can't (they never
// bootstrap Nest).
describe("ObservabilityModule wiring", () => {
  it("resolves the pino Logger and the metrics registry", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule],
    }).compile();

    expect(moduleRef.get(MetricsService)).toBeInstanceOf(MetricsService);
    expect(moduleRef.get(Logger)).toBeDefined();

    // The registry renders (default Node.js metrics are present).
    const out = await moduleRef.get(MetricsService).render();
    expect(out).toContain("process_cpu_seconds_total");

    await moduleRef.close();
  });
});
