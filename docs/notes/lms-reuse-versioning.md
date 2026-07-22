# LMS reuse/versioning

> LMS content version history (append-only) + revert + clone/reuse; new RLS table, built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS program feature **#12 reuse/versioning** — built 2026-07-11, live-verified, **UNCOMMITTED**.

New tenant table **`lms_content_revision`** (append-only snapshot of an LmsContent's title/body/type): migration `20260811000000_lms_content_revision`, RLS `54_lms_content_revision_rls.sql` (**SELECT+INSERT only** — no UPDATE/DELETE, like audit_log; sentinel `lms_content_revision_insert`), registered in `docker-entrypoint.sh`, + a cross-tenant case in `rls.e2e-spec.ts` (declared `lmsContentRevisionA`, seeded, cases array, cleanup before lms_content, coverage gate green). Applied to live DB (relrowsecurity=t; grants INSERT,SELECT).

`LmsContentService`: private `snapshot(tx,p,row,note)` (version = count+1) called after every create ("Created"), edit ("Edited"), and revert. Public: `listRevisions` (staff-of-class, newest first, 404 via assertTeacherOfClass), `revertToRevision` (only DRAFT/REVISION_REQUESTED; snapshots current first so it's non-destructive → new version "Reverted to vN"), `cloneContent(contentId, targetClassId?)` (fresh DRAFT copy "X (copy)", strips approval state; cross-class clone drops module+subjectId/termId tag since the subject may not be offered there; must author BOTH source and target class). New `LmsRevisionDto` (metadata only — body stays server-side). Endpoints gated `lms.content.write`: GET `/content/:id/revisions`, POST `/content/:id/revert/:revisionId`, POST `/content/:id/clone`. Web: `ContentReuse.tsx` (`ContentItemTools` — Clone + History-expander + Revert) wired per-item into `ContentManager` (canAuthor).

Verified live: create→v1, edit→v2, history=2, revert restores title+body→v3 "Reverted to v1", clone→DRAFT "(copy)" with own v1. Student on `/revisions` → 403 (coarse content.write gate — correct; a teacher of ANOTHER class gets 404 via relationship scoping). api tsc 0, web tsc 0, builds green, JS+CSS 200.

Same LMS program as [lms-block-editor](lms-block-editor.md) / [lms-gradebook-push](lms-gradebook-push.md). Program now 8/12: done #1-5, #9, #12. Remaining: #11 engagement, #6 live classroom, #10 analytics, #8 SCORM, #13 offline. Deploy gotchas (learned): `pkill -f`/`pgrep -f` on the launch path SELF-MATCH the shell wrapper → kill by explicit PID from `ss -ltnp`; foreground `sleep` blocked → poll.
