# Hydration & CSV hardening

> App-wide hydration-safe formatters + CSV formula-injection defence (2026-07-01 review)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Comprehensive-review hardening (2026-07-01):

**Hydration safety — the recurring "client-side exception" root cause.** `apps/web/lib/format.ts` (`money`/`shortDate`/`dateTime`) used the RUNTIME-DEFAULT locale + timezone, which differs between the Node SSR (UTC) and the browser (user's zone) → React throws a hydration mismatch when a client component renders SSR'd data. Now PINNED to `LOCALE="en-NG"` + `TIME_ZONE="Africa/Lagos"` (WAT) so server and client output are identical (and times are correct for the Nigerian audience). This fixes the whole class app-wide — many client "Manager" components (Transport/Library/Hostel/Fees/Payroll/PlatformAudit…) render SSR'd props with these formatters. **Rule: any value formatted with locale/timezone AND present in SSR HTML must use a pinned formatter, or render client-only behind a mounted gate** (Recharts panels in `charts/rc.tsx` already use the `ChartFrame` mounted gate + `isAnimationActive={false}`).

**CSV formula injection (OWASP).** Report exports (`platform-audit.service.ts`, `hr/payroll.service.ts`, `library/library.service.ts`) now prefix a cell with `'` when it begins with `= + - @ tab CR`, so Excel/Sheets treat attacker-influenceable values (audit actions/metadata, staff names, book titles) as text, not formulas. Quoting alone does NOT stop this — the `'` prefix does.

**Dead code removed:** the old dependency-free SVG chart kit `apps/web/components/charts/charts.tsx` is now ONLY `Kpi` (Donut/Bars/Columns/CHART/Segment deleted — replaced by Recharts `rc.tsx`). Stale plan-tier comments in `dto/operator.ts` + `dto/subscription.ts` corrected (BASIC → STANDARD|PREMIUM|ULTIMATE|ENTERPRISE).

Verified clean: super_admin-only surfaces (platform audit list/export) 403 for non-super_admin; school demographics gated to staff + `student.profile.read` (parents get none); no `dangerouslySetInnerHTML`; new analytics/audit services use batched `findMany` (no N+1); full API suite 440/440, monorepo typecheck 13/13.
