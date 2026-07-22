# Junior admin tier

> junior_admin role (operational tier, no approvals) + ADMIN_APPOINTMENT maker-checker + admin lockout/payment-race guards

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built 2026-07-19 after the "can two school admins conflict?" discussion:

1. **Two-admin conflict fixes**: `recordPayment` row-locks the invoice
   (`FOR UPDATE`, hostel pattern) before the overpayment check; approve/reject
   payment use an optimistic `updateMany` claim on PENDING_APPROVAL (racing
   deciders — loser gets "not pending"). `removeRole` 409s on removing your OWN
   school_admin/principal role and on removing the school's LAST managing role
   (`RBAC_MANAGING_ROLES` in admin.service.ts).
2. **junior_admin role** in `ROLE_PERMISSIONS` (role-map.ts): day-to-day ops +
   `fee.manage` (record) + `admission.review`, NO rbac.manage / fee.approve /
   workflow.review / hr.* / medical / billing — split by risk of escalation like
   platform manager_admin. Demo login `junioradmin@demo.school`.
3. **ADMIN_APPOINTMENT workflow type** (systemOnly, single-stage legacy chain):
   any grant touching the junior tier (assigning `junior_admin`, or stacking
   roles onto a holder) is raised by `AdminService.assignRole`/`createUser` as a
   workflow request (`raiseAppointment`); `createUser` makes the account
   ROLE-LESS until approval. The grant lands in the finalized hook (registered
   in the AdminService constructor, AdminModule imports WorkflowModule),
   audited to the initiator with `makerChecker: true`. Engine SoD means the
   OTHER senior (school_admin/principal hold workflow.review) must approve.

**Why:** user wanted a senior/junior admin org structure with dual-controlled
junior appointments; conflicts between equal admins addressed by audit +
maker-checker, not by forbidding multiple admins.

4. **Operator oversight**: `GET /operator/admin-appointments`
   (platform.tenants.read, privileged client, [] when unset, ?state= filter) +
   a read-only "Admin appointments" panel on /operator — the owner SEES every
   tenant's appointment + state but the decision stays with the school's
   second senior. Commits e9b2be2 / 6b1c96f / e8ddb49, all pushed.

5. **Games oversight coherence (same session, UNCOMMITTED as of writing)**:
   GET /games/:id and /rings/:id now gate on `game.leaderboard.read` with a
   service oversight bypass (SCHOOL_WIDE_ROLES or `game.match.moderate`) —
   staff can VIEW to moderate; new `POST /games/:id/end` duel force-end;
   /ws/watch duel/ring modes mirror the REST gate; hub cards gated
   play-or-host; DuelPlay moderate button. **PermissionGuard: super_admin
   BYPASSES @RequireModule** (platform org has no subscription — module-tagged
   operator surfaces like Ultimate admin 404'd; impersonation carries target
   roles so it still respects modules). 64/64 live game smoke (all 10 game
   surfaces incl. typing anti-cheat + ultimate consent chain + WS push).

Tests: `test/admin/admin-remove-role.service.spec.ts`,
`test/admin/admin-appointment.service.spec.ts`, updated fees spec. Docs:
CLAUDE.md RBAC section, API.md admin rows, /help guides, smoke role list.
See [july-2026-hardening-sweep](july-2026-hardening-sweep.md) for the concurrency-guard patterns reused.
