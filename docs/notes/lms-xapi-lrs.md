# LMS xAPI LRS

> LMS xAPI (Tin Can) Learning Record Store — record/query learning statements + auto-emit; new RLS table (file 57); built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#8 SCORM/xAPI** — built 2026-07-11, live-verified, **UNCOMMITTED**. Scoped to the standards-compliant **xAPI (Tin Can) Learning Record Store** (the substantive, verifiable core). NOTE: full SCORM PACKAGE hosting (unzip imsmanifest.xml + the `API_1484_11` JS runtime bridge) is the documented FUTURE layer — needs real object storage + a JS shim, not verifiable in-sandbox.

New tenant table **`xapi_statement`** (actorId/verb/objectId/objectName/classId?/result jsonb): migration `20260814000000_xapi_statement`, RLS `57_xapi_statement_rls.sql` (**SELECT/INSERT only — immutable, like audit_log**; sentinel `xapi_statement_insert`), registered in `docker-entrypoint.sh`, RLS-e2e case added (coverage gate green). Applied to live DB.

Pure `xapi.util.ts`: `isXapiVerb` (allow-list: experienced|completed|passed|failed|attempted|answered|progressed) + `normalizeXapiResult` (bounds score/max, keeps only recognised flags, caps response 1000). 4 unit tests. `XapiVerb`/`XapiResult`/`XapiStatementDto` in @sms/types.

`LmsContentService`: `recordStatement` (**actor ALWAYS = JWT userId, never trusted from body** — a student records only their own activity; class-scoped statement requires caller belongs to the class), `listStatements` (relationship-scoped: staff-of-class→all class statements [optional studentId], else→OWN only; capped 500), private `emitStatement` (in-tx). **Auto-emission**: markComplete → "completed"; attemptQuiz → "passed"/"failed" (≥50%) or "attempted" (essays pending), with score result. Endpoints gated `lms.content.read`: POST/GET `/xapi/statements`. Web: `XapiActivity.tsx` "Recent activity (xAPI)" table on the `/classes/[id]/analytics` page (SSR, staff).

Verified live: unknown verb→400; record→201 with actorId=caller (JWT, not body); content-complete auto-emits; teacher class query→all w/ names; student query→own only. api tsc 0, web tsc 0, 31 util tests, builds green, JS+CSS 200.

Same LMS program. Program now 11.5/12: done #1-5,#9,#12,#6,#10,#11,#8(LRS). ONLY REMAINING: **#13 offline/PWA**. (Web build >2min — Bash timeout 300000.)
