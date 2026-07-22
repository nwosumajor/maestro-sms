# HR org + analytics v2

> HR program Phase 9 — org chart/reporting lines (managerId, cycle-checked) + HR analytics v2 (attrition/tenure/payroll trend/attendance/loans/lifecycle); live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 9 (features #11 org structure + #14 analytics v2)** — built 2026-07-12, live-verified, **UNCOMMITTED**. One tiny migration (`20260821000000_org_reporting_line`: `employee.managerId UUID` nullable), no new table/RLS.

**#11**: `employee.managerId` = line manager's userId. Upsert accepts it with guards: self-manager 400; **cycle detection** (walk up the chain max 20 hops — if it reaches the employee, 400); manager without an employment record 404 (first hop only). `GET /hr/org` (hr.read) returns flat ACTIVE nodes {userId,name,jobTitle,department,gradeLevel,managerId}; the web nests. New `OrgNodeDto`; `EmployeeDto.managerId`. Web: `OrgChart.tsx` (server component, recursive tree; **normalizes orphaned managerIds to roots so a mid-tree exit never hides a branch**) on /hr; EmployeeForm gains a "Reports to" select fed from /hr/org.

**#14**: `HrAnalyticsDto` v2 additions (aggregates only, no PII/salaries): `attrition` {exitsLast12m (APPROVED staff_exit decidedAt ≥ 1y ago), ratePercent = exits/(active+exits)}, `tenure` buckets (<1y/1-3/3-5/5+ from ACTIVE startDate), `payrollTrend` (last 6 FINALIZED runs incl. runType), `attendanceThisMonth` (P/L/A/⚑ from staff_attendance), `loans` {active, outstandingMinor (decrypted sum)}, `lifecycle` {onProbation, contractsEnding60d}. Web analytics page: 4 new stat tiles + "Payroll trend" + "Workforce shape" cards.

Verified live: chain warden→headadmin→hrmanager set; self-manager 400, cycle 400, ghost 404; org tree 3 nodes nested right; analytics reflects ALL prior phases' real data — attrition 1/25% (the exited teacher), onProbation 1 (warden), payrollTrend shows monthly + 13th runs, attendance month P0/L1/A1/⚑1. api+web tsc 0, route smoke 69 routes green.

HR program **13/15 done** (#1-#11, #13, #14; #12 covered by staff_document). **ONLY #15 biometric terminal ingestion remains** (device registry + HMAC-signed event endpoint + employee mapping → staff_attendance source BIOMETRIC; verify with a simulated device).
