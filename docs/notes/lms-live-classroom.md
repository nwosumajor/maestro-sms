# LMS live classroom

> LMS live/virtual classroom — scheduled Zoom/Meet/Jitsi sessions + attendance register; 2 new RLS tables, built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#6 live classroom** — built 2026-07-11, live-verified, **UNCOMMITTED**.

Two new tenant tables: **`lms_live_session`** (scheduled session: classId/title/provider/joinUrl/startsAt/durationMinutes/status/hostId) + **`lms_live_attendance`** (append-only per-student join record, unique(sessionId,studentId)). Migration `20260812000000_lms_live_session`; RLS `55_lms_live_rls.sql` — session SELECT/INSERT/UPDATE (cancel=status, no DELETE), attendance SELECT/INSERT only (sentinel `lms_live_attendance_insert`); registered in `docker-entrypoint.sh`; 2 cross-tenant cases in `rls.e2e-spec.ts` (coverage gate green). Applied to live DB.

Pure util `lms-live.util.ts`: `normalizeJoinUrl(provider,url)` — https-only + host-allowlist per provider (zoom.us / meet.google.com / meet.jit.si|*.8x8.vc; OTHER = any https), same posture as the video-embed canonicaliser; `isJoinable(status,startsAt,duration,now)` — window [start-15m, start+duration+30m], never for ENDED/CANCELLED. 5 unit tests.

Methods on `LmsContentService` (reuses its assertTeacherOfClass/canAuthor/assertEnrolledOrGuardian scoping): createLiveSession (teacher-of-class), listLiveSessions (relationship-scoped; attendee counts staff-only via groupBy), joinLiveSession (server gates the window, reveals URL, records attendance for enrolled STUDENT only — idempotent), updateLiveSession (host or staff; status/reschedule/relink), listLiveAttendance (host/staff). **joinUrl is NEVER in the list DTO** — only the join endpoint returns it. Endpoints on lms-content.controller: POST/GET `/classes/:id/live`, POST `/live/:id/join` (CONTENT_READ), PUT `/live/:id` + GET `/live/:id/attendance` (CONTENT_WRITE). Web `LiveSessions.tsx` on the class content page (list+join for all; create/status/attendance for canManage; join opens URL in new tab noopener).

Verified live: bad URL→400; create→201 (joinable, no joinUrl in dto); student join→URL+attendance (idempotent); teacher attendeeCount=1 + register; cancel→join 409; student attendance→403. api tsc 0, web tsc 0, 25 util tests, builds green, JS+CSS 200.

Same LMS program as [lms-reuse-versioning](lms-reuse-versioning.md)/[lms-block-editor](lms-block-editor.md)/[lms-gradebook-push](lms-gradebook-push.md). Program now 9/12: done #1-5,#9,#12,#6. Remaining: #11 engagement, #10 analytics, #8 SCORM, #13 offline/PWA.
