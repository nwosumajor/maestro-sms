// =============================================================================
// A tenant's data is not somebody else's cache entry
// =============================================================================
// Measured on the running stack before this: `/students`, `/invoices`,
// `/notifications`, `/analytics/overview` and `/hr/employees` all answered 200
// with `cache-control: null`, and a `Vary` naming only Next's RSC headers.
//
// LATENT AT THE EDGE, and said so honestly: CloudFront runs
// `Managed-CachingDisabled` as its ONE behaviour and the shipped nginx has no
// `proxy_cache`, both checked. What it is not latent for is everything this
// platform does not own — a school's own network proxy, and the browser's disk
// cache and back-button on the shared scan desk and attendance kiosk.
//
// TWO PLACES, and the second is the one that reaches the browser. The BFF
// proxy REBUILDS the header set from scratch (`const out = { "Content-Type":
// ct }`), and its own comment already says why that matters — it re-adds
// `X-Content-Type-Options` for exactly this reason. Whatever it does not name
// does not arrive.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..", "..", "src");
const WEB = join(__dirname, "..", "..", "..", "web");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("the API's own responses", () => {
  const mw = stripComments(readFileSync(join(API_SRC, "common", "no-store.middleware.ts"), "utf8"));

  it("sets a private, no-store Cache-Control", () => {
    expect(mw).toMatch(/setHeader\(\s*"Cache-Control",\s*"private, no-store"\s*\)/);
  });

  it("varies on the things that identify the caller", () => {
    // Belt and braces for a cache that ignores `no-store` but honours a key.
    // Without this a URL is the whole key and two sessions collide.
    expect(mw).toMatch(/setHeader\(\s*"Vary",\s*"[^"]*Cookie[^"]*"\s*\)/);
  });

  it("is wired into every route, ahead of anything that can respond", () => {
    const app = stripComments(readFileSync(join(API_SRC, "app.module.ts"), "utf8"));
    const apply = app.match(/consumer\.apply\(([^)]*)\)\.forRoutes\("\*"\)/);
    expect(apply).not.toBeNull();
    const names = apply![1].split(",").map((n) => n.trim());
    expect(names).toContain("NoStoreMiddleware");
    // A guard that short-circuits still gets the header if this runs first.
    expect(names.indexOf("NoStoreMiddleware")).toBe(0);
  });
});

describe("the BFF proxy, which owns the headers it rebuilds", () => {
  const route = stripComments(readFileSync(join(WEB, "app", "api", "sms", "[...path]", "route.ts"), "utf8"));

  it("builds its header set from scratch — so it must name what it wants", () => {
    // The premise of the two assertions below. If this stops being true the
    // proxy is forwarding the API's headers and they may cover it instead.
    expect(route).toMatch(/const out: Record<string, string> = \{/);
  });

  it("names Cache-Control on the response the browser actually sees", () => {
    expect(route).toMatch(/out\["Cache-Control"\]\s*=\s*"private, no-store"/);
  });

  it("names Vary, so a shared cache cannot key on the URL alone", () => {
    expect(route).toMatch(/out\["Vary"\]\s*=\s*"[^"]*Cookie[^"]*"/);
  });

  it("still names the header set it already had, which this must not displace", () => {
    // Regression guard: these were the point of the rebuild in the first place
    // (a stored-XSS hole and every broken CSV export).
    expect(route).toMatch(/out\["X-Content-Type-Options"\]/);
    expect(route).toMatch(/out\["Content-Security-Policy"\]/);
    expect(route).toMatch(/out\["Content-Disposition"\]/);
  });
});

describe("the PUBLIC proxy, which deliberately differs", () => {
  const pub = readFileSync(join(WEB, "app", "api", "public", "[...path]", "route.ts"), "utf8");

  it("does not carry the no-store across, and says why", () => {
    // A decision, not an oversight: everything through there is the school
    // directory, plan pricing and vacancy listings — identical for every caller
    // and personal to nobody. Pinned so the difference stays deliberate.
    expect(stripComments(pub)).not.toMatch(/Cache-Control/);
    expect(pub).toMatch(/DELIBERATELY NO `Cache-Control`/);
  });

  it("still serves nothing personal and nothing binary", () => {
    // The premise of the line above. `@Public` byte routes live on the
    // AUTHENTICATED controllers (the applicant CV, the supplied-document file);
    // if one ever appears under /public/*, this proxy would both corrupt it
    // (`res.text()`) and leave it cacheable.
    const publicControllers = [
      "public/public.controller.ts",
      "documents/public-documents.controller.ts",
      "hr/attendance.controller.ts",
    ];
    for (const rel of publicControllers) {
      const src = stripComments(readFileSync(join(API_SRC, rel), "utf8"));
      expect(src).not.toMatch(/StreamableFile/);
    }
  });
});

describe("nothing in the deployment quietly caches instead", () => {
  const TF = join(__dirname, "..", "..", "..", "..", "infrastructure");

  it("CloudFront's only behaviour is CachingDisabled", () => {
    // The header fix is defence in depth BECAUSE of this. If somebody adds a
    // caching behaviour later, the headers are what will hold — but the claim
    // in the comments should stop being true loudly, not silently.
    const cf = readFileSync(join(TF, "terraform", "cloudfront.tf"), "utf8");
    expect(cf).toMatch(/cache_policy_id\s*=\s*data\.aws_cloudfront_cache_policy\.disabled\.id/);
    expect(cf).toMatch(/name\s*=\s*"Managed-CachingDisabled"/);
    expect(cf).not.toMatch(/ordered_cache_behavior/);
  });

  it("the shipped nginx has no proxy_cache", () => {
    expect(readFileSync(join(TF, "nginx", "nginx.conf"), "utf8")).not.toMatch(/proxy_cache\b/);
  });
});
