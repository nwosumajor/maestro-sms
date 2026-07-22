# Engineering notes

Build notes from the sessions that produced this system: what was built, **why**
a design went the way it did, and the gotchas that cost real time. They exist
because the reasoning behind a decision is usually more expensive to recover
than the code itself.

## How to read these

- **[CLAUDE.md](../../CLAUDE.md) is the durable spec** — the authoritative
  description of how the system works today. These notes are *point-in-time*
  records, written at the end of the session that did the work.
- A note may therefore be **stale**: it can name a file, flag or endpoint that
  has since moved or been renamed. Verify against the code before relying on a
  specific detail — trust the *reasoning* more than the coordinates.
- Status lines like "UNCOMMITTED" describe the moment of writing, not today.
- The most durable value is in the **gotchas**: why the migration history does
  not replay from scratch, why a newer `pg_dump` can produce a dump that will
  not restore, why a new permission needs both a re-seed *and* an image rebuild,
  why an e2e suite must disconnect the Prisma singleton or CI hangs.

## Index

Roughly chronological — the order the work happened.

- [Assessment Integrity module](assessment-integrity-module.md) — build status + key decisions (foundation absent, SubmissionTelemetry amendment, app role = major_user)
- [Design tokens & Stitch](design-tokens-and-stitch.md) — token system locations, per-tenant brand swap, Stitch project handle
- [Monorepo scaffolding](monorepo-scaffolding.md) — runnable Turborepo/pnpm setup, auth flow, foundation placeholders, sandbox-has-no-network limit
- [Real foundation](real-foundation.md) — placeholders replaced with real DB-backed auth/RBAC/audit/consent, verified end-to-end
- [LMS module](lms-module.md) — first product module: Classes/Enrollment/Guardians + relationship-scoping RBAC, verified
- [Hardening: migrations/tests/CI](hardening-migrations-tests-ci.md) — tracked Prisma migrations, committed RLS+relationship tests (run vs real Postgres), GitHub Actions CI; full pipeline verified locally
- [Gradebook module](gradebook-module.md) — second product module: manual grading + teacher-of-class/student/parent read scoping, verified
- [Dead & Wounded game](dead-and-wounded-game.md) — game platform (spec §11) COMPLETE: steps 1–8 built (1–3 in commit e883c53; 4–8 uncommitted), typecheck+engine tests pass, DB e2e gated on CI creds
- [Module entitlements](module-entitlements.md) — super_admin per-school subscription/module toggles (plan tiers + overrides); @RequireModule guard 404s, web nav hides; verified vs live DB
- [LMS content module](lms-content-module.md) — approval-gated learning content (materials/lessons/quizzes/forums); backend committed dc868d3, web UI added this session (uncommitted); typecheck+build+util test green
- [Full-stack run verified](full-stack-run-verified.md) — whole stack run live (DB+Redis+API+Web+game-server); api 182 tests + build green vs real Postgres (2026-06-26)
- [Platform-owner org model](platform-owner-org-model.md) — super_admin lives in an isPlatform=true system org (not a customer school); excluded from public list/operator tenants/directory; onboarding picks plan + extra modules
- [Enterprise feature expansion](enterprise-feature-expansion.md) — big add-on-module program; Hostel/Transport/Library DONE; Task/Poll/Discussion/Discipline/exam/alumni etc. remaining
- [Hydration & CSV hardening](hydration-and-csv-hardening.md) — pinned locale/TZ formatters (fixes client-exception class) + CSV formula-injection defence + dead-code cleanup (2026-07-01 review)
- [Branding logo on PDFs + audit pagination](branding-logo-and-audit-pagination.md) — school logo on certificates/report cards (direct upload + storage download + pdfkit embed) + platform-audit keyset pagination (2026-07-01)
- [Password policy & lockout](password-policy-and-lockout.md) — 30-day forced reset (super_admin exempt) + 3-strike permanent lockout, super_admin-only reactivation (2026-07-01)
- [Warden & driver roles](warden-driver-roles.md) — new warden/driver roles, relationship-scoped hostel/transport access + module analytics; super_admin control via operator (2026-07-01)
- [July 2026 hardening sweep](july-2026-hardening-sweep.md) — the big review/fix session: revenue+security fixes, redesign, operator pricing, 3 new roles, maker-checker, concurrency guards; ALL UNCOMMITTED; local-dev env recipe
- [Academic grading + parent feature](academic-grading-parent-feature.md) — term-weighted grades, subject-selection & grade-publish maker-checker, initiator-routed workflows, parent portal; all live-verified, UNCOMMITTED
- [Web route smoke](web-route-smoke.md) — logs in as every role, asserts every SSR page renders; catches the 500s jest can't. Run: pnpm --filter @sms/web smoke:routes
- [LMS gradebook push](lms-gradebook-push.md) — tag LMS quizzes/assignments with (subject,term), aggregate → pull into report-card CA slice via merge-aware TermResultService; live-verified, UNCOMMITTED
- [LMS block editor](lms-block-editor.md) — lessons: raw-HTML `{html}` → structured plain-text `{blocks}` model (kills stored-XSS, no dangerouslySetInnerHTML); legacy html converts on read; live-verified, UNCOMMITTED
- [LMS reuse/versioning](lms-reuse-versioning.md) — append-only lms_content_revision table (history/revert) + clone; new RLS file 54 + e2e case; live-verified, UNCOMMITTED
- [LMS live classroom](lms-live-classroom.md) — scheduled Zoom/Meet/Jitsi sessions + attendance register; 2 new RLS tables (file 55), https host-allowlist, server-gated join window; live-verified, UNCOMMITTED
- [LMS learning analytics](lms-learning-analytics.md) — per-class dashboard (completion/quiz/assignment/live + engagement signal); read-only, no new table; SSR /classes/[id]/analytics; live-verified, UNCOMMITTED
- [LMS engagement badges](lms-engagement-badges.md) — teacher-awarded achievement badges (LMS_BADGES catalog in @sms/types); new RLS table (file 56), student-notified; live-verified, UNCOMMITTED
- [LMS xAPI LRS](lms-xapi-lrs.md) — xAPI/Tin Can Learning Record Store (record/query + auto-emit on complete/quiz); new RLS table (file 57, immutable); actor-from-JWT; live-verified, UNCOMMITTED
- [LMS PWA/offline](lms-pwa-offline.md) — installable manifest + service worker (static-only cache, network-only /api for PII safety, offline fallback); CDP-verified; COMPLETES the 12-item LMS program (all but #7 AI); UNCOMMITTED
- [HR money cluster](hr-money-cluster.md) — HR program Phase 1: allowances/deductions + staff loans (maker-checker, payroll auto-recovery, net≥0 clamp) + self-serve payslips; RLS file 58; principal granted hr.payroll.run; live-verified, UNCOMMITTED
- [HR run types + remittance](hr-runtypes-remittance.md) — HR program Phase 2: 13th-month/bonus runs (PAYE-only, no loan recovery) + PAYE/pension/NHF remittance CSVs from snapshotted breakdowns + encrypted TIN/RSA PIN; live-verified, UNCOMMITTED
- [HR staff attendance](hr-staff-attendance.md) — HR program Phase 3: anti-spoofing attendance (admin register + rotating TOTP kiosk code, IP flag signals, unified table ready for biometric); RLS file 59; live-verified, UNCOMMITTED
- [HR duty roster](hr-duty-roster.md) — HR program Phase 4: bulk dated duty shifts for non-timetabled staff (notify assignees, my-duties self view); RLS file 60; live-verified, UNCOMMITTED
- [HR employment lifecycle](hr-employment-lifecycle.md) — HR program Phase 5: probation→confirmation/promotion/renewal maker-checker (rows = employment history) + contract-expiry sweep + grade levels; RLS file 61; live-verified, UNCOMMITTED
- [HR exit management](hr-exit-management.md) — HR program Phase 6: final-settlement exits (pro-rata+leave−loans, step-up maker-checker, ledger recovery, auto offboarding checklist); RLS file 62; COMPLETES Tier 2; live-verified, UNCOMMITTED
- [HR letter generator](hr-letter-generator.md) — HR program Phase 7: official letters (employment/confirmation/promotion/experience) on the school letterhead w/ audited ref numbers, salary never printed; no new table; live-verified, UNCOMMITTED
- [HR careers page](hr-careers-page.md) — HR program Phase 8: public /careers/[slug] + rate-limited quarantined intake → existing ATS (ZERO system actor, no audit on public path — actorId FK); live-verified, UNCOMMITTED
- [HR org + analytics v2](hr-org-analytics-v2.md) — HR program Phase 9: reporting lines/org chart (cycle-checked managerId) + analytics v2 (attrition/tenure/payroll trend/attendance/loans); live-verified, UNCOMMITTED
- [HR biometric ingestion](hr-biometric-ingestion.md) — HR program Phase 10: device registry + HMAC-signed event ingestion → staff_attendance BIOMETRIC (templates never stored); RLS file 63; COMPLETES the 15-item HR program; simulated-device verified, UNCOMMITTED
- [super_admin coherence audit](superadmin-coherence-audit.md) — platform org now excluded from ALL public slug resolvers (4 fixes); host-run API needs DATABASE_MIGRATE_URL for operator analytics/audit; impersonation verified into new HR features
- [Careers CV upload](careers-cv-upload.md) — public apply takes a PDF CV (magic-byte checked, 5 MB multer cap → 413), bytes via StorageProvider, audited HR download, BFF proxy fixed for multipart; API-verified, UNCOMMITTED
- [Branding portal logo](branding-portal-logo.md) — logo in signed-in AppShell for all staff + square 128–2048px validation; member endpoint fixes staff theme 403; live-verified, UNCOMMITTED
- [Categorised people pickers](categorised-people-pickers.md) — GET /users?kind= filter + all pickers categorised staff vs students (supervisor bug fixed); live-verified, UNCOMMITTED
- [Pricing propagation fix](pricing-propagation-fix.md) — homepage no longer caches plan prices 5 min (no-store) + PlanPricingService Redis cache fan-out; operator price edits show instantly; live-verified, UNCOMMITTED
- [Onboarding flow upgrade](onboarding-flow-upgrade.md) — public form plan/module choice + owner in-app alert + Approve & provision prefill/auto-approve/welcome; migration ledger repaired (18 resolves); live-verified, UNCOMMITTED
- [Dual-currency billing](dual-currency-billing.md) — NGN (Paystack) + USD (Stripe) subscriptions; ENTERPRISE USD-only across homepage/quotes/checkout/operator; live-verified minus real gateway creds, UNCOMMITTED
- [Email delivery](email-delivery.md) — real outbound email (Resend/Postmark, env-gated) + receipts/dunning/welcome/owner-alerts tagged EMAIL + direct onboarding requester ack/live/rejected emails; stub-verified, UNCOMMITTED
- [Operator billing alerts](operator-billing-alerts.md) — red alerts for lapsed schools: dunning digest to super_admin (in-app+email), /operator red banner, SubscriptionManager restore/extend controls; live-verified, UNCOMMITTED
- [Invite links & help manual](invite-links-and-help.md) — set-password invite links (7d, single-use) for provisioned admins + role-aware /help manual; provisioning now truly forces first-login reset; live-verified, UNCOMMITTED
- [School disable, pw-reset, login carousel](school-disable-pwreset-carousel.md) — DISABLE blocks all logins (new operator lever+toggle), public forgot-password flow (30m single-use), login-page image carousel; live-verified, UNCOMMITTED
- [Settlement & login showcase](settlement-and-login-showcase.md) — Paystack split settlement per school (fees → school bank, school bears charge) + full-image login panel with image-derived palettes; live-verified, UNCOMMITTED
- [Homepage conversion review](homepage-conversion-review.md) — RevenueBand fee-collection USP + FAQ objection handling + settlement messaging + accurate steps + pricing reassurance; live-verified, UNCOMMITTED
- [Payment receipts & role guides](payment-receipts-and-role-guides.md) — every posted fee payment now receipts payer+guardians+student w/ balance; failure notices; /help covers all 17 roles; middleware matcher holes fixed; live-verified, UNCOMMITTED
- [Gateway refunds & overpayment](gateway-refunds-overpayment.md) — approved CARD refunds auto-push to Paystack (original card only, manual fallback notice) + webhook overpayment alerts finance; live-verified, UNCOMMITTED
- [Dark console theme](dark-console-theme.md) — app restyled to the reference graphite dark console via .dark tokens scoped to AppShell; homepage/login stay light; 17-role smoke green, UNCOMMITTED
- [Platform logo](platform-logo.md) — MajorGBN mark is the default everywhere (nav, footer, login, app header, favicon); school-uploaded logos override only in their own portal; verified, UNCOMMITTED
- [MAESTRO owner relocation](maestro-owner-relocation.md) — platform org renamed MAESTRO-SMS, owner relocated out of St. Andrews (seed self-heals now), header shows Super Admin Console; verified, UNCOMMITTED
- [MajorGBN brand color & footer](majorgbn-brand-color-footer.md) — default brand = logo blue hsl(203,72%,30%) app-wide (tokens in globals.css AND packages/tokens); footer: Powered by MajorGBN Innovations Limited + link columns; verified, UNCOMMITTED
- [MajorGBN two-tone brand](majorgbn-two-tone-brand.md) — SUPERSEDES the single blue: navy primary hsl(205,68%,26%) + logo-green --accent-2/brand2 token for affirmative accents (checks, trial chip); dark primary softened; live-verified + 17-role smoke green, UNCOMMITTED
- [Onboarding auto-credentials](onboarding-auto-credentials.md) — Approve & provision auto-generates school_admin+principal sign-in accounts from the slug; requester emailed sign-in emails + set-password links (never passwords); console temp passwords auto-hide 10 min; SMOKE_ROLES needs FULL emails; live-verified, UNCOMMITTED
- [Transparent platform logo](transparent-platform-logo.md) — logo/mark/favicon rebuilt with transparent bg (near-white→alpha incl. glyph counters, de-haloed edges); all 5 mark sites drop the bg-white plate (school logos keep theirs); live-verified, UNCOMMITTED
- [Classroom games engines](classroom-games-engines.md) — PHASE 1 of 5 new games (live quiz/typing/hangman/chess/checkers): pure engines in packages/game-engine BUILT + 168 tests green; per-game SMS integration (schema/RLS/service/web) still TODO; chess+checkers namespaced; UNCOMMITTED
- [Live Quiz module](live-quiz-module.md) — 1st of 5 games FULLY DONE (backend + web): 5 tenant tables, RLS file 64, service/controller, game.quiz.host perm, engine scoring, answer hidden mid-question; web host console + play screen at /games/quiz; edit/delete + starter quizzes; COMMITTED (merged to main)
- [Typing Race module](typing-race-module.md) — 3rd game: typing_race/racer tables, RLS 67, game.typing.host, server-computed WPM, passage shown; /games/typing; committed cc9c543 on branch feat/games-typing-checkers-chess
- [Checkers + Chess board games](board-games-checkers-chess.md) — games 4+5 (COMPLETE the 5-game program): peer duels reusing game.play (no new perm), server-validated moves, interactive board web UIs, RLS 68/69; chess persists full state (castling/ep/clocks); MERGED to main (2157153) + pushed to origin. All 5 games now shipped on main.
- [Impersonation](impersonation.md) — why it had no web UI (browser never holds an API token); audit hole fixed (imp.by → ALS request context → every audit entry); session bridge + banner built; exit = sign out
- [Platform permission split + manager_admin](platform-permission-split.md) — platform.operate (one god-perm over 25 endpoints) split by RISK OF ESCALATION; manager_admin gets delegable duties, owner keeps impersonate/credentials/pricing/student-PII; NON_ELEVATABLE spreads ALL_PLATFORM_PERMISSIONS; merged 78bdfa6
- [Docker build network hardening](docker-build-network-hardening.md) — README compose build failures = host WiFi latency vs Node timeouts; Dockerfiles now retry + cache + patient NODE_OPTIONS; COMMITTED+pushed
- [Referral program](referral-program.md) — school-refers-school: both sides earn a free term on first paid sub; atomic GUC-switch grant in the webhook tx; + same-session game gap fixes, design pass, homepage marketing, public-page theme fix; COMMITTED+pushed (c46afdd)
- [Revenue program](revenue-program.md) — 8 monetization levers (take-rate, admission fees, auto-renew, proration/true-up, promos/agents, message credits, group console, CBT); webhook-dispatch + global-table patterns; MERGED+pushed (ac2f687)
- [Scaling to 5000 schools program](scaling-5000-schools-program.md) — COMPLETE: read/write split, pooling, pagination, rate-limit, audit partitioning, read-through cache, load-test harness all merged; sharding intentionally discarded (5k load test: writer idle, real fix was entitlement-cache TTL). Sharding is a ~50k-school concern.
- [Scholarship chain](scholarship-chain.md) — student requests + supervisor→parent→principal→platform chain, exam pipeline, Best-Three awards; relationship-scoped stages as application states
- [Slim session cookie](slim-session-cookie.md) — cookie carries ROLES only (3.7KB→1.2KB, 502-class risk gone); ROLE_PERMISSIONS single source in @sms/types (seed imports it); API guard expands roles→perms (60s cache); smoke enforces 3KB budget
- [Junior admin tier](junior-admin-tier.md) — junior_admin role + ADMIN_APPOINTMENT maker-checker appointments + admin lockout & payment-race guards
- [Branding logo location + certificate redesign](branding-logo-and-certificate-redesign.md) — surfaced orphaned /admin/branding nav link; professional vector certificate/ID-card PDFs, on-brand per school; COMMITTED ce6f0e5
- [CSP timetabling](csp-timetabling.md) — real backtracking solver (quotas + teacher availability + rooms + diagnostics), rls/77, web console, service e2e; 749 tests + live smoke green; COMMITTED 2c66a2b/45a7bbf, not pushed
- [Gap-closure batch (eight items)](gap-closure-batch-eight.md) — report-card remarks, notification prefs, teacher cover, exam logistics, meetings, global search, MFA policy, verified backup/restore; new perms need a seed re-run AND a backend image rebuild
- [Payments completion program](payments-completion-program.md) — six-item payments hardening (recon/NUBAN/installments/USD/fee-ops) + disputes + idle-logout, all PUSHED; InvoiceSettlementService is the ONE posting path; webhook dispatch order matters
- [Test DB container](test-db-container.md) — sms-test-pg on 5434 (postgres:postgres; major_user pw = infrastructure/.env APP_DB_PASSWORD), db push not migrate, audit_log before user in cleanups
- [CBT governance](cbt-governance.md) — Kahoot-style question form, teacher subject scoping, publish maker-checker, principal-gated answer release; fixed SYSTEM-actor FK bug + RLS gate gap; migrations DON'T replay from scratch (use db push for fresh test DBs); 715 tests + 22-check live smoke green; PUSHED to origin (d5d09f3); live DB purged of a crashed test run's fixtures
