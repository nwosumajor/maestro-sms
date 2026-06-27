import { MetricsService } from "./metrics.service";

// Unit tests for the prom-client registry wrapper: HTTP counters aggregate by
// bounded labels (method/route/status), the latency histogram is cumulative, the
// route PATTERN (not raw path) keeps cardinality bounded, per-tenant volume is a
// separate counter, and the default Node.js process metrics are present.
describe("MetricsService", () => {
  it("counts requests by method/route/status in Prometheus text", async () => {
    const m = new MetricsService();
    m.observeHttp("GET", "/invoices/:id", 200, 0.02, "school-a");
    m.observeHttp("GET", "/invoices/:id", 200, 0.04, "school-a");
    m.observeHttp("GET", "/invoices/:id", 404, 0.01, "school-b");

    const out = await m.render();
    expect(out).toContain('http_requests_total{method="GET",route="/invoices/:id",status="200"} 2');
    expect(out).toContain('http_requests_total{method="GET",route="/invoices/:id",status="404"} 1');
    expect(out).toContain("# TYPE http_requests_total counter");
  });

  it("emits a cumulative histogram with +Inf, sum and count", async () => {
    const m = new MetricsService();
    m.observeHttp("POST", "/billing/checkout/init", 200, 0.2, "school-a");
    m.observeHttp("POST", "/billing/checkout/init", 200, 0.6, "school-a");

    const out = await m.render();
    const base = 'method="POST",route="/billing/checkout/init"';
    // prom-client renders the `le` label first. 0.2 and 0.6: le="0.25" holds 1,
    // le="1" holds both (cumulative).
    expect(out).toContain(`http_request_duration_seconds_bucket{le="0.25",${base}} 1`);
    expect(out).toContain(`http_request_duration_seconds_bucket{le="1",${base}} 2`);
    expect(out).toContain(`http_request_duration_seconds_bucket{le="+Inf",${base}} 2`);
    expect(out).toContain(`http_request_duration_seconds_count{${base}} 2`);
    expect(out).toContain(`http_request_duration_seconds_sum{${base}} 0.8`);
  });

  it("counts per-tenant request volume separately (bounded by school_id)", async () => {
    const m = new MetricsService();
    m.observeHttp("GET", "/students", 200, 0.01, "school-a");
    m.observeHttp("GET", "/students", 200, 0.01, "school-a");
    m.observeHttp("GET", "/students", 200, 0.01, "school-b");

    const out = await m.render();
    expect(out).toContain('tenant_requests_total{school_id="school-a"} 2');
    expect(out).toContain('tenant_requests_total{school_id="school-b"} 1');
  });

  it("includes the default Node.js process metrics", async () => {
    const m = new MetricsService();
    const out = await m.render();
    expect(out).toContain("process_cpu_seconds_total");
    expect(out).toContain("nodejs_eventloop_lag_seconds");
    expect(m.contentType()).toContain("text/plain");
  });
});
