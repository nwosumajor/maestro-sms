# HR letter generator

> HR program Phase 7 — official HR letter generator (employment/confirmation/promotion/experience PDFs on the school letterhead, audited ref numbers); no new table; live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 7 (feature #10 letter generator)** — built 2026-07-12, live-verified, **UNCOMMITTED**. First Tier-3 feature. **No new table/migration/RLS** — letters are generated on demand from the live employee record; each issuance is AUDITED (`hr.letter.issue`) with a deterministic printed **reference number** (`SCH/HR/EMP/XXXXXXXX`) so any paper copy traces back to the audit trail. The letter footer states this.

`LetterService` (`GET /hr/letters/:userId/pdf?type=EMPLOYMENT|CONFIRMATION|PROMOTION|EXPERIENCE`, gated `hr.write`): formal Nigerian letter format via pdfkit — letterhead with the school's uploaded logo (**reuses `BrandingService.getLogoBytes`**, best-effort embed like the certificate module), ref + date, TO WHOM IT MAY CONCERN, per-type body from the employee facts (title/grade/department/dates/employment type), signature block. **SECURITY: salary never appears on any letter** (they're handed to banks/embassies). Guards: CONFIRMATION letter 400 unless confirmationStatus=CONFIRMED; EXPERIENCE works for both current (has served…to the present day) and EXITED staff (served from…to endDate). HrModule now imports BrandingModule.

Web: an "Official letters" row on the `EmploymentLifecycle` card (`/hr/staff/[userId]`) — 4 direct PDF links through the BFF.

Verified live: all 4 types → 200 application/pdf, %PDF magic bytes (~2.1-2.3KB); experience letter for the EXITED teacher works; confirmation-on-probation → 400; bad type → 400; teacher (no hr.write) → 403. api+web tsc 0, route smoke 69 routes green.

NOTE re #12 TRCN tracking: largely covered by existing `staff_document` (kind + expiresAt + reminder sweep) — a school records "TRCN licence" as a document kind today; remaining polish is only a UI suggestion, so #12 may be folded into a later pass or marked covered.

HR program 10/15 (#1-#10). Remaining Tier 3: #11 org chart/reporting lines, #12 (mostly covered), #13 public careers page, #14 analytics v2; then #15 biometric ingestion.
