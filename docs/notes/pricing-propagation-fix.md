# Pricing propagation fix

> Operator plan-price changes now hit the public homepage instantly — removed the landing page's 5-min Next data cache (no-store) + Redis fan-out for PlanPricingService cache; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User report: super_admin updated tier pricing but the public homepage kept the
old price. Two stacked caches:
1. **The actual culprit**: `apps/web/app/page.tsx` fetched `/public/plan-pricing`
   with `next: { revalidate: 300 }` — a 5-minute Next data cache. Now
   `cache: "no-store"`; the homepage went static→dynamic (`ƒ /`), each view asks
   the API (answered from its in-memory cache, so cheap).
2. `PlanPricingService` 60s per-instance cache only cleared on the replica that
   handled the PUT. Now fans `plan-pricing:invalidate` over `RedisPubSubService`
   (mirrors `entitlement:invalidate`; @Optional, degrades to local-only without
   Redis). Single provider in BillingModule (operator/public import it) — no
   duplicate-instance cache issue.

Verified live: PUT bump ₦500→₦501 → public endpoint AND homepage show ₦501 on
the immediate next request; restore → ₦500 instantly. NOTE: the user's real
operator price for STANDARD is ₦500/seat/mo (override over the ₦200 default) —
preserved. Step-up flow for operator PUTs: `POST /security/stepup` {password} →
`x-stepup` header. UNCOMMITTED.
