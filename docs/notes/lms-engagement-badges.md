# LMS engagement badges

> LMS engagement via teacher-awarded achievement badges; new RLS table (file 56), student-visible + notified; built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#11 engagement** (achievement badges) — built 2026-07-11, live-verified, **UNCOMMITTED**. (Forum/discussion + notifications already existed, so the fresh value is positive recognition.)

Data-driven catalog `LMS_BADGES` (+`isBadgeKey`/`badgeMeta`) in `packages/types/src/lms-badges.ts` (8 badges: STAR_CONTRIBUTOR, QUIZ_MASTER, etc.) — shared by API (validation) + web (icon/label), no catalog table. New tenant table **`lms_award`** (classId/studentId/badge/note/awardedById): migration `20260813000000_lms_award`, RLS `56_lms_award_rls.sql` (SELECT/INSERT/**DELETE** — a teacher may revoke a mistaken award; no UPDATE; sentinel `lms_award_delete`), registered in `docker-entrypoint.sh`, RLS-e2e case added (coverage gate green). Applied to live DB.

`LmsContentService`: `awardBadge` (teacher-of-class; validates isBadgeKey; student must be ACTIVE-enrolled; **notifies the student** best-effort via NotificationService — the engagement payoff), `listAwards` (relationship-scoped: staff→all, enrolled student→OWN, guardian→children), `revokeAward` (teacher-of-class, hard delete). Human-in-the-loop, positive-only (Golden Rule #8: never automated/punitive). `LmsAwardDto` in @sms/types. Endpoints: POST/GET `/classes/:id/awards`, DELETE `/awards/:id`. Web `Awards.tsx` on the content page (everyone sees badges; teacher gets award form using the `/classes/:id/progress` roster + revoke); student sees own as celebratory cards.

Verified live: unknown badge→400; award→201; teacher list→all w/ names; student→own only; student award→403; revoke→200→student count 0. api tsc 0, web tsc 0, 27 util tests, builds green, JS+CSS 200.

Same LMS program as [lms-learning-analytics](lms-learning-analytics.md) etc. Program now 11/12: done #1-5,#9,#12,#6,#10,#11. Remaining: **#8 SCORM/xAPI, #13 offline/PWA**. NOTE: web build now takes >2min — use Bash timeout 300000.
