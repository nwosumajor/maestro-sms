# Gap-closure batch (eight items)

> Eight-item gap-closure batch (2026-07-21): report-card remarks, notification prefs, teacher cover, exam logistics, meetings, global search, MFA policy, verified backups — all pushed, CI green

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The user asked "is there anything else missing in the whole system", I audited
and proposed a prioritized list, and they picked all eight. Built, tested,
pushed through `eb0bf06`; CI green. Details in CLAUDE.md ("Cross-cutting batch
(July 2026, eight items)") and API.md (634 endpoints / 75 controllers).

New tenant tables + RLS files (each with a cross-tenant case in rls.e2e-spec):
83 report_card_remark · 84 notification_preference · 85 lesson_cover ·
86 meeting_slot + meeting_booking · 87 exam_sitting + exam_seat +
exam_invigilator. API suite 817 → **849 tests**.

Non-obvious facts worth keeping:
- **New permissions need BOTH a seed re-run AND (for the live compose stack) a
  BACKEND IMAGE REBUILD** — the container ships its own compiled `@sms/types`,
  so re-seeding alone replays the STALE role map. This bit me: a sed adding the
  new perms to every role holding `timetable.write` also hit `junior_admin`; I
  kept `exam.manage` there (desk logistics, no approval power — defensible) but
  removed `meeting.host` (a teaching relationship), and the correction only
  landed after rebuilding the backend.
- New perms this batch: `meeting.host` (teacher/principal/school_admin),
  `meeting.book` (parent), `exam.manage` (principal/school_admin/junior_admin).
- `restore-drill.sh` is the real deliverable of the backup item — it FAILED on
  first run and caught two genuine issues: (1) a host `pg_dump` 18 emits
  `SET transaction_timeout` which a PG16 server REJECTS on restore (a dump that
  looks healthy and is unrestorable) — both scripts now take `PG_CONTAINER` to
  use a version-matched client; (2) the RLS assertion needed the documented
  `ultimate_participant` exemption. Run it monthly per
  docs/RUNBOOK-BACKUP-RESTORE.md.
- Notification delivery now filters external channels through the pure
  `allowedChannels()` in `@sms/types`; the in-app inbox is never suppressed and
  ESSENTIAL types ignore per-type mutes. Any NEW notification producer inherits
  this automatically (it lives in `persist()`), so don't re-implement it.
- Teacher cover joins APPROVED leave × timetable by weekday over a bounded
  62-day window — there is no cover table row until someone is assigned.
- Global search (`GET /search?q=`) has NO @RequirePermission: every category is
  gated INSIDE the service by the permission the caller holds. Add categories
  the same way or you will leak.
- Live-verification technique unchanged from [payments-completion-program](payments-completion-program.md);
  [test-db-container](test-db-container.md) for the local suites.
