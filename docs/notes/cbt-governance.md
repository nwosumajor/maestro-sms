# CBT governance

> CBT governance batch — Kahoot-style question form, teacher subject scoping, exam-publish maker-checker, principal-gated answer release; plus 2 latent bugs fixed (SYSTEM actor FK, RLS coverage gap)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built 2026-07-18 (session after the [revenue-program](revenue-program.md) CBT exam hall). Four
user-requested CBT changes, all live-verified end-to-end; live quiz instant
reveal deliberately left ungated (user's decision):

1. **Kahoot-style CBT authoring** — `CbtStaffPanel` rebuilt: per-question form
   (prompt + per-option inputs + correct-answer radio + add-option up to 6 +
   add-question), bulk pipe-format paste kept as a second tab.
2. **Teacher subject scoping** — `classSubjectTeacher` is authoritative: a
   teacher may only create banks for subjects they teach (subjectId REQUIRED for
   them; `cbt_question_bank.subjectId` added), only touch banks they own/teach,
   and must aim exams at a class where they teach the bank's subject
   (404-not-403). school_admin/principal (SCHOOL_WIDE_ROLES) unrestricted. New
   `GET /cbt/authoring-options` feeds the web pickers.
3. **Exam publish maker-checker** — new systemOnly workflow type
   `CBT_EXAM_PUBLISH` (legacy single-stage → any workflow.review holder ≠
   initiator). `POST /cbt/exams/:id/request-publish` claims DRAFT→
   PENDING_APPROVAL (updateMany guard, revert-on-failure mirrors
   `publishResults`); reactor in CbtService constructor flips PUBLISHED/DRAFT
   in-tx. `PUT status` now only accepts CLOSED.
4. **Gated answer release** — `CBT_ANSWER_RELEASE` type with
   `CBT_ANSWER_RELEASE_CHAIN` = single PRINCIPAL stage
   (workflow.review.principal). `cbt_exam.answerRelease`
   (HIDDEN|REQUESTED|RELEASED) + `answersReleasedAt`; request allowed only when
   CLOSED or window ended. `sittingView` reveals answerIndex only when finished
   AND released; score stays visible at submit. Migration
   `20260911000000_cbt_governance` (columns only, no new RLS file).

**Two latent bugs found and fixed during verification:**
- **SYSTEM actor FK**: `ReferralService.grantRewardsInTx` audits with
  `SYSTEM_ACTOR_ID` (zero UUID) but no such `user` row existed anywhere (live DB
  included) → `audit_log_actorId_fkey` would abort the real payment webhook tx
  on any referral reward. Fixed: seed now upserts a DISABLED, role-less
  `system@sms.platform` user with the zero UUID in the platform org; billing
  e2e creates it hermetically (ON CONFLICT DO NOTHING); inserted manually into
  the running compose DB.
- **RLS coverage gate gap**: `agent_commission` and `school_group_member`
  (deny-all tables, rls/72+74) had NO coverage case — masked before because
  past test DBs never had those RLS files applied. Added a deny-all test
  (app role gets `permission denied` even in its OWN tenant) + covered-set
  entries + FK-ordered cleanup.

**Environment gotchas (re-learned):**
- The repo's migration history does NOT replay from scratch:
  `20260713020000_multi_currency_billing` references `plan_price` created by the
  LATER-stamped `20260726000000` (ledger was repaired in-place on live DBs, see
  [onboarding-flow-upgrade](onboarding-flow-upgrade.md)). Fresh test DBs must be built with
  `prisma db push` + `pnpm rls` + seed, not `migrate deploy`.
- Local test DB recipe used: containers `sms-test-pg` (host 5434, UTC) +
  `sms-test-redis` (6380); app role password reset via
  `ALTER ROLE major_user LOGIN PASSWORD 'majorpw'`. DB-gated jest suites need
  DATABASE_URL/DATABASE_MIGRATE_URL/DATABASE_RETENTION_URL set too, not just
  TEST_DATABASE_URL/TEST_ADMIN_URL.

Verified: 91/91 API suites (19-case new `cbt.service.spec`), RLS gate green,
api+web tsc clean, docker images rebuilt, and a 22-check live smoke inside the
backend container (token-minted per role) covering the entire journey incl.
negatives (self-approve 403, admin-can't-release 403, key withheld post-submit).
Smoke fixtures cleaned from the live DB. COMMITTED as 404195e (feature) +
02fa5c7 (SYSTEM actor fix) + d5d09f3 (RLS gate cases) and PUSHED to origin/main.
Also cleaned (data-only, no commit needed): a crashed 2026-07-15 test run had
been pointed at the LIVE compose DB, stranding 4 fixture schools (A/B/RA/RB),
a junk `role-<uuid>` role (surfaced on /admin/recertification), a test user and
an arena fixture row — all swept with an FK-ordered multi-pass delete. Rule:
DB-gated suites run ONLY against sms-test-pg (5434), never the compose DB.
