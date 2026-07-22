# HR run types + remittance

> HR program Phase 2 — 13th-month/bonus payroll runs + statutory remittance pack (PAYE/pension/NHF CSVs, TIN/RSA PIN on employee); live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 2 (features #3 bonus/13th-month runs, #4 statutory remittance pack)** — built 2026-07-12, live-verified, **UNCOMMITTED**. No new tables → no new RLS file (columns on already-RLS'd tables).

Migration `20260816000000_payroll_run_type_statutory`: `payroll_run` gains `runType` (MONTHLY|THIRTEENTH|BONUS, default MONTHLY backfills) + `bonusPercent`; **uniqueness widened to (schoolId,year,month,runType)** so a December 13th-month coexists with December monthly. `employee` gains `tinEnc` + `rsaPinEnc` (encrypted statutory ids; accepted via the employee upsert — undefined=keep, null/""=clear; decrypted in EmployeeDto for the audited hr.read path).

Pure (packages/types/src/payroll.ts): `computeBonusPayslip(base, percent)` — percent of BASIC only, **PAYE applies (approximated as a regular month), pension 0, no components/loans**; `employerPensionMinor(gross)` = 10% employer cost. Non-MONTHLY runs skip component/loan queries entirely, so **finalize does NOT recover loans on bonus runs** (breakdown.loans empty). Payslip PDF titles show "(13th month)"/"(bonus N%)".

`GET /hr/payroll/runs/:id/remittance?type=paye|pension|nhf` (hr.payroll.run, FINALIZED-only → 400 on DRAFT, audited): built from **snapshotted breakdowns, never recomputed**. PAYE: name/TIN/gross/PAYE. Pension: name/RSA PIN/gross/employee 8%/employer 10%/total — skips pension-less (bonus) slips. NHF: rows only where a deduction component named "NHF" exists (schools opt in by adding the component). CSV formula-injection escaped like bank export.

Web: PayrollManager run form gains type select + bonus %, period cell shows 13th/bonus badges, FINALIZED rows get PAYE/Pension/NHF download links; EmployeeForm gains TIN + RSA PIN inputs.

Verified live: upsert stores+returns TIN/RSA, salary preserved; 13th run July alongside monthly (409 on dup); 13th slip = 20M base-only, PAYE-only 1,752,667; loan balance UNCHANGED by 13th finalize; PAYE csv "TIN-12345678",230000.00,21942.67; pension csv 18400/23000/41400 (8%/10% exact); NHF header-only; DRAFT remittance 400; teacher 403. RLS 123/123, payroll spec 14/14 (3 new pure tests), api+web tsc 0, route smoke green.

Prior phase: [hr-money-cluster](hr-money-cluster.md). Next: Tier 2 — #6 staff attendance (modes A admin-register / B TOTP-kiosk+IP-signal), #7 duty rostering, #8 contracts/confirmation, #9 exit management; then Tier 3 + #15 biometric ingestion.
