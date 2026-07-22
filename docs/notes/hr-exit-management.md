# HR exit management

> HR program Phase 6 — exit management (final settlement calc, step-up maker-checker, loan recovery to ledger, auto offboarding checklist); RLS file 62; live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 6 (feature #9 exit management)** — built 2026-07-12, live-verified, **UNCOMMITTED**. Completes Tier 2.

Pure `computeFinalSettlement` in `packages/types/src/payroll.ts`: pro-rata final month (calendar-day basis: dayOfMonth/daysInMonth × basic) + leave payout (remaining entitled−used days × basic/30) − loan recovery **clamped at gross (net ≥ 0; `loanUnrecoveredMinor` reports residue)**. 2 unit tests (payroll spec now 16).

New table **`staff_exit`** (type RESIGNATION|TERMINATION|RETIREMENT, lastWorkingDay, **`settlementEnc` = encrypted FinalSettlement JSON frozen at initiation**, PENDING/APPROVED/REJECTED, initiator/decider): migration `20260820000000_staff_exit`, RLS `62_staff_exit_rls.sql` (SELECT/INSERT/UPDATE, no DELETE — permanent record; sentinel `staff_exit_update`), entrypoint, RLS-e2e case (128/128). **`loan_repayment.payrollRunId` made NULLABLE** — a NULL run = exit-settlement recovery, keeping the append-only ledger complete (StaffLoanDto.repayments period shows "exit settlement"; withRepayments filters null runIds).

`ExitService` (`/hr/exits`): initiate (hr.write; employee must be ACTIVE; one PENDING per user; settlement computed from decrypted salary + Σ leave balances (year of last day) + Σ ACTIVE loan balances, snapshot-encrypted; amounts kept out of audit metadata). decide (**hr.salary.approve + @RequireStepUp**, ≠ initiator): approve in ONE tx → employee status=EXITED + endDate=lastWorkingDay, loans recovered oldest-first (ledger rows w/ NULL runId; SETTLED at 0; residue stays ACTIVE), then **offboarding checklist auto-created** post-commit via injected StaffLifecycleService (best-effort; account disabling stays a human checklist task, never automatic). list (hr.read, audited — decrypts settlements).

Web: `ExitPanel` on `/hr/staff/[userId]` — initiate form (hidden once PENDING/APPROVED exists), settlement breakdown lines (pro-rata/leave/loan/net + still-owed warning), approve/reject via postWithStepUp.

Verified live (teacher: ₦200k base, ₦60k loan balance, no leave rows): initiate → proRata 15/31×200k = **9,677,419 kobo exact**, loan recovery 6,000,000, net 3,677,419 consistent; dup 400; initiator-self-decide 403; principal-no-step-up 403 → step-up approve → employee **EXITED** endDate 2026-08-15, loan **balance 0 SETTLED**, **OFFBOARDING checklist created (5 tasks)**; re-initiate on EXITED 400. RLS 128/128, payroll spec 16/16, api+web tsc 0, route smoke green.

**Tier 2 complete.** HR program 9/15 (#1-#9). Remaining: Tier 3 — #10 HR letter generator, #11 org chart/reporting lines, #12 TRCN/cert tracking, #13 public careers page, #14 analytics v2 — and #15 biometric ingestion.
