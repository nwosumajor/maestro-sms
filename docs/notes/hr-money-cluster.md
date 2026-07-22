# HR money cluster

> HR program Phase 1 — allowances/deductions, staff loans with payroll recovery, self-serve payslips; 3 new RLS tables (file 58); live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 1 (features #1 allowances/deductions, #2 loans/advances, #5 self-serve payslips)** — built 2026-07-12, live-verified end-to-end, **UNCOMMITTED**. (The full 15-item HR program: Tier1 money #1-5, Tier2 presence/lifecycle #6-9 incl. anti-spoofing staff attendance + TOTP kiosk, Tier3 #10-14, #15 biometric ingestion. User approved the phased plan.)

Schema (migration `20260815000000_hr_pay_components_loans`, RLS `58_hr_compensation_rls.sql`, sentinel `loan_repayment_insert`): `pay_component` (full CRUD — config; payslips snapshot), `staff_loan` (no DELETE — financial record; amounts encrypted like salaries), `loan_repayment` (append-only ledger, unique(loanId,payrollRunId) = finalize idempotency). `payslip.breakdownEnc` = encrypted `FullPayslipBreakdown` JSON snapshot — **payslip PDF renders from THIS, never recomputes** (legacy slips fall back to statutory-only reconstruct).

Pure `computeFullPayslip` in `packages/types/src/payroll.ts`: gross = base + allowances (statutory PAYE+pension on full gross); deductions = statutory → other → loans, with **loan installments CLAMPED so net ≥ 0** (partial recovery rolls to next run). `PayrollService.createRun` applies active components + ACTIVE loans (installment = min(monthly, balance)); **`finalizeRun` posts recovery** (atomic DRAFT→FINALIZED via updateMany count guard; repayment rows + balance decrement + auto-SETTLE at 0 in the same tx). Loans maker-checker mirrors salary: request `hr.self` (needs employee record, ≤3 open), decide `hr.salary.approve` + **step-up** + ≠requester. Self-serve: `GET /hr/payroll/me/payslips` + `me/payslips/:runId/pdf` (`hr.self`; own + FINALIZED only). New `CompensationService/Controller`; DTOs PayComponentDto/StaffLoanDto/MyPayslipDto.

**Seed fix:** granted `hr.payroll.run` to principal (was hr_manager-only → finalize-by-different-person impossible in a single-HR school; mirrors the earlier hr.salary.approve hardening). Applied to live DB via role_permission insert.

Web: `CompensationPanel` (staff detail page, hr.write), `LoansAdmin` (payroll page, postWithStepUp decisions), `MyCompensation` (leave page: payslip PDFs + loan request/history).

Verified live: employee ₦200k + housing ₦30k + co-op ₦5k; loan ₦100k @ ₦20k/mo → PENDING → step-up approve; run gross 23,000,000 / net 16,465,733 kobo (math exact); finalize by principal → balance 10M→8M→6M over two runs, repayment ledger rows; self PDFs 200; teacher blocked from decide (403), /hr/loans (403), no-step-up (403 STEPUP_REQUIRED); creator-finalize 403. RLS e2e **123/123** (3 new cases, coverage gate green); payroll spec 11/11 (mock updated for new models); api+web tsc 0; route smoke (hrmanager/teacher/principal × 68 routes) green.

Next phases: #3 13th-month/bonus runs, #4 statutory remittance pack, then Tier 2 (#6 staff attendance modes A/B, #7 rostering, #8 contracts, #9 exit), Tier 3, #15 biometric.
