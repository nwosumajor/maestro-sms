# HR careers page

> HR program Phase 8 — public careers page (/careers/[slug]) + quarantined application intake feeding the existing ATS; no new table; live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 8 (feature #13 public careers page)** — built 2026-07-12, live-verified, **UNCOMMITTED**. No new table — reuses `job_requisition` + `applicant` (ATS from the earlier HR roadmap).

**Mirrors the /public/admissions posture exactly**: `PublicCareersController` (own controller at `/public/careers` — NOT under the hr/recruitment prefix or its module gate). `GET /public/careers/:slug` → school name + OPEN vacancies (title/department/description/openings — no PII). `POST /public/careers/:slug/apply` (`@Public` + `RateLimitGuard(10/min)`): school resolved by slug via the RLS-exempt registry under the ZERO GUC, then applicant created under THAT school's GUC (stage APPLIED, `createdById = ZERO` system actor); a foreign requisitionId isn't visible under the GUC → 404; non-OPEN → 404; **one application per (requisition, lowercased email)** → 409. **NO audit.record on the public path — `audit_log.actorId` FKs to a real user, so a ZERO actor 500s (FK violation); the applicant row itself is the submission record — same reason /public/admissions doesn't audit.** Web BFF: the existing `/api/public/[...path]` catch-all proxy covers careers with zero new code.

Web: PUBLIC page `apps/web/app/careers/[slug]/page.tsx` (server-fetches openings from API_BASE_URL directly, no-store; graceful "couldn't find" for bad slugs) + `components/public/CareersBoard.tsx` (vacancy cards + inline apply form posting via `/api/public/careers/:slug/apply`).

**Gotcha found**: `RecruitmentService.createRequisition` hardcodes `status:"OPEN"` (despite the model's DRAFT default) — every created vacancy is instantly public. Pre-existing behavior; schools control visibility via the status endpoint (CLOSED/FILLED hide it). Worth revisiting if a school wants draft-first authoring.

Verified live: public GET lists only OPEN roles (CLOSED hidden), bad slug 404; public apply 201 → **lands in HR's ATS pipeline** (`/hr/recruitment/applicants?requisitionId=`, stage APPLIED); dup email (case-insensitive) 409; apply to CLOSED 404; web page renders school + vacancies publicly at `/careers/demo`, unknown slug graceful. api+web tsc 0, route smoke 69 routes green.

HR program 11/15 (#1-#10, #13; #12 covered by staff_document). Remaining: #11 org chart/reporting lines, #14 analytics v2, #15 biometric ingestion.
