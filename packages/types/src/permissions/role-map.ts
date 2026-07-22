// =============================================================================
// Role -> permission matrix — THE single source of truth for RBAC assignment.
// =============================================================================
// Moved here from packages/db/prisma/seed.ts so ONE definition drives all three
// consumers, which previously could drift:
//   1. the SEED (packages/db/prisma/seed.ts imports this to write Role/
//      Permission/RolePermission rows — the DB the API resolves from),
//   2. the WEB session callback (derives session.user.permissions from the
//      cookie's ROLES via permissionsForRoles — the permissions array itself no
//      longer rides in the Auth.js cookie, keeping it small forever), and
//   3. the API's RolePermissionsService DB-outage fallback.
// Role->permission assignment is platform-level configuration ("adding a role/
// permission is a seed change, not new code" — CLAUDE.md); per-user ROLE
// assignment stays data (user_role rows), and JIT elevation stays additive at
// the API guard. Changing this map still requires a re-seed to update the DB.
export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  // Platform owner: cross-tenant operator console + audited impersonation.
  // super_admin is the cross-tenant operator; the ONLY game permission it holds
  // is the cross-school Ultimate admin (+ leaderboard read to view it).
  // notification.read: the operator's in-app inbox (new-onboarding-request
  // alerts). Self-scoped reads only — grants no reach into tenant data.
  super_admin: [
    // Owner identity + EVERY platform power, including the ones never delegated.
    "platform.operate",
    "platform.tenants.read", "platform.tenants.write", "platform.onboarding.review",
    "platform.audit.read", "platform.user.read", "platform.user.unlock", "platform.grace.manage",
    "platform.impersonate", "platform.user.credentials", "platform.tenants.status",
    "platform.subscription.manage", "platform.pricing.manage", "platform.student.read",
    "platform.staff.manage",
    "billing.dunning.run", "fee.reconcile.run", "security.audit.read", "directory.search",
    "game.ultimate.admin", "game.leaderboard.read", "scholarship.admin", "scholarship.read",
    "notification.read",
  ],
  // Platform STAFF, employed by the owner to run day-to-day duties. Lives in the
  // platform org alongside super_admin, but is NOT the owner: it deliberately does
  // NOT hold `platform.operate` (so no cross-school directory / owner framing), nor
  // anything that is or becomes absolute control —
  //   impersonate .......... becomes any user
  //   user.credentials ..... a temp password / MFA reset IS a login for that account
  //   tenants.status ....... takes a paying school offline
  //   subscription/pricing . changes what customers pay
  //   student.read ......... minors' PII across every tenant (Golden Rule #5)
  //   rbac.manage .......... would let it grant itself roles
  // All of the above are ALSO non-elevatable, so it cannot JIT-elevate into them.
  // Every action it takes is audited and attributed to it, exactly like the owner's.
  manager_admin: [
    "platform.tenants.read", // registry, analytics, billing alerts
    "platform.tenants.write", // onboard schools + add their admins
    "platform.onboarding.review", // triage public signup requests
    "platform.audit.read", // see what's happening platform-wide
    "platform.user.read", // support triage: look up an account
    "platform.user.unlock", // support: clear a lockout (grants no access)
    "platform.grace.manage", // extend a late payer's grace (hard-capped => not a comp)
    "notification.read", // own inbox (onboarding alerts)
  ],
  // Board: read-only oversight + ultimate veto on workflows.
  board: ["poll.vote", "discussion.participate", "discipline.file", "form.respond", "class.read", "grade.read", "integrity.report.read", "workflow.read", "workflow.veto", "notification.read", "fee.read", "document.read", "timetable.read", "message.read", "message.send", "event.read", "announcement.read", "billing.read", "scholarship.read",
  ],
  // Principal: full operational view of their school (can grade, review workflows).
  principal: [
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write", "subject.manage", "student.import", "parent.import", "class.promote", "academic.manage",
    "grade.read", "grade.write",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.principal",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "hostel.read", "hostel.manage",
    "transport.read", "transport.manage",
    "library.read", "library.borrow", "library.manage",
    "task.assign", "task.participate",
    "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "cbt.manage", "alumni.manage", "form.manage", "form.respond",
    "document.read", "document.write",
    "timetable.read", "timetable.write", "meeting.host", "exam.manage",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "hr.read", "hr.self", "hr.write", "hr.salary.approve", "hr.payroll.run", "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage", "school.branding.manage", "rbac.manage", "admission.review", "directory.search", "announcement.manage", "announcement.read",
    "game.league.create", "game.leaderboard.read",
    "game.race.open", "game.race.tournament", "game.match.moderate", "game.quiz.host", "game.hangman.host", "game.typing.host",
    "game.ultimate.enroll",
    "lms.content.read", "lms.content.approve",
    "billing.read", "billing.manage",
    "scholarship.read", "scholarship.apply",
  ],
  // School Administrator: SIS / enrollment / workflows — but NOT grade books, NOT veto.
  school_admin: [
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write", "subject.manage", "subject.selection.approve", "student.import", "parent.import", "class.promote", "academic.manage",
    "assessment.read", "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "integrity.retention.run",
    "grade.read", "grade.write",
    "student.profile.read", "student.profile.write", "student.contact.read",
    "student.contact.write", "student.medical.read", "student.medical.write",
    "attendance.read", "attendance.write",
    "workflow.create", "workflow.read", "workflow.review",
    "notification.read", "notification.send",
    "fee.read", "fee.manage", "fee.approve",
    "hostel.read", "hostel.manage",
    "transport.read", "transport.manage",
    "library.read", "library.borrow", "library.manage",
    "task.assign", "task.participate",
    "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "cbt.manage", "alumni.manage", "form.manage", "form.respond",
    "document.read", "document.write",
    "timetable.read", "timetable.write", "meeting.host", "exam.manage",
    "security.audit.read", "security.elevation.request", "security.elevation.approve",
    "privacy.erasure.review", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "hr.read", "hr.self", "hr.write", "hr.salary.approve", "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage", "school.branding.manage", "rbac.manage", "admission.review", "directory.search", "announcement.manage", "announcement.read",
    // School admin approves end-of-session promotions (maker-checker checker).
    "class.promote.approve",
    "game.league.create", "game.leaderboard.read",
    "game.race.open", "game.race.tournament", "game.match.moderate", "game.quiz.host", "game.hangman.host", "game.typing.host",
    "game.settings.manage",
    "game.ultimate.enroll", "game.ultimate.consent",
    "lms.content.read", "lms.content.write", "lms.forum.post",
    "billing.read", "billing.manage",
    "scholarship.read",
  ],
  // Junior school admin: the DAY-TO-DAY operational tier under school_admin,
  // split (like platform manager_admin) by RISK OF ESCALATION. Records fees and
  // reviews admissions, but every APPROVAL power stays senior-only:
  //   rbac.manage .......... could assign itself school_admin
  //   fee.approve .......... checker side of the money maker-checker
  //   workflow.review ...... would make it an approver of its own tier's requests
  //   hr.* / salary ........ staff pay + records stay with HR/senior
  //   medical / privacy .... minors' sensitive PII (Golden Rule #5, restrictive)
  //   billing / branding / game settings / audit ... governance, senior-only
  // Appointing a junior_admin (or adding roles to one) is itself maker-checker
  // via the ADMIN_APPOINTMENT workflow. JIT elevation covers the occasional
  // senior need; NON_ELEVATABLE_PERMISSIONS blocks the dangerous set.
  junior_admin: [
    "class.read", "class.write", "enrollment.read", "enrollment.write", "guardian.write", "student.import", "parent.import",
    "assessment.read", "integrity.report.read", "integrity.exemption.read",
    "grade.read",
    "student.profile.read", "student.profile.write", "student.contact.read", "student.contact.write",
    "attendance.read", "attendance.write",
    "workflow.create", "workflow.read",
    "notification.read", "notification.send",
    "fee.read", "fee.manage",
    "hostel.read", "transport.read", "library.read",
    "task.assign", "task.participate", "poll.vote",
    "discussion.participate", "discipline.file", "form.respond",
    "document.read", "document.write",
    "timetable.read", "timetable.write", "exam.manage",
    "security.elevation.request",
    "message.read", "message.send", "event.read", "event.write", "announcement.read", "announcement.manage",
    "hr.self", "admission.review", "directory.search",
    "lms.content.read",
  ],
  teacher: ["hr.self", "task.assign", "task.participate", "poll.manage", "poll.vote",
    "discussion.participate", "discussion.moderate", "discipline.file", "discipline.manage", "certificate.issue", "cbt.manage", "alumni.manage", "form.manage", "form.respond",
    "assessment.read", "assessment.write", "submission.read",
    "integrity.report.read", "integrity.exemption.read", "integrity.exemption.write",
    "student.profile.read", "student.contact.read",
    "attendance.read", "attendance.write",
    "class.read", "enrollment.read", "grade.read", "grade.write",
    "workflow.create", "workflow.read",
    "notification.read", "notification.send",
    "document.read", "document.write",
    "timetable.read", "meeting.host",
    "security.elevation.request", "message.read", "message.send", "event.read", "announcement.read", "event.write",
    "game.play", "game.leaderboard.read", "game.quiz.host", "game.hangman.host", "game.typing.host", "game.race.open", "game.match.moderate",
    "lms.content.read", "lms.content.write", "lms.forum.post",
    "scholarship.apply",
  ],
  student: [
    "assessment.read", "submission.read", "submission.write",
    "integrity.signal.create", "class.read", "grade.read", "subject.select",
    "student.profile.read", "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read", "announcement.read",
    "game.play", "game.leaderboard.read", "cbt.take",
    "lms.content.read", "lms.quiz.attempt", "lms.forum.post",
    "library.read", "library.borrow",
    "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "scholarship.apply",
  ],
  parent: [
    "poll.vote", "family.read", "meeting.book",
    "class.read", "grade.read",
    "student.profile.read", "student.contact.read", "student.medical.read",
    "attendance.read",
    "notification.read", "fee.read", "document.read",
    "timetable.read", "message.read", "message.send", "event.read", "announcement.read",
    "lms.content.read",
    "scholarship.apply",
  ],
  // Non-teaching staff: narrow. Both can raise workflow requests (POs / leave).
  // The accountant owns Fees/Billing.
  accountant: ["hr.self", "poll.vote", "discussion.participate", "discipline.file", "form.respond", "workflow.create", "workflow.read", "notification.read", "fee.read", "fee.manage", "document.read", "document.write", "security.elevation.request", "message.read", "message.send", "event.read", "announcement.read", "billing.read",
  ],
  hr_clerk: ["hr.self", "poll.vote", "discussion.participate", "discipline.file", "form.respond", "workflow.create", "workflow.read", "notification.read", "security.elevation.request", "hr.read", "hr.write", "message.read", "message.send", "event.read", "announcement.read", "student.import", "parent.import", "class.read", "enrollment.read",
  ],
  // HR Manager: owns leave/salary/payroll + is the HR (stage-2) approver of the
  // staff-request chain. Salary maker-checker still needs TWO distinct managers.
  hr_manager: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.hr",
    "hr.read", "hr.write", "hr.salary.request", "hr.salary.approve", "hr.leave.manage", "hr.payroll.run",
    "hr.appraisal.manage", "hr.disciplinary.manage", "hr.recruit.manage",
    // Coarse gate for the admissions review surface; the HR stage of the
    // maker-checker still requires the granular workflow.review.hr above.
    "admission.review", "student.import", "parent.import",
    // HR may view class lists + rosters (read-only) for onboarding/oversight.
    "class.read", "enrollment.read",
    "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Head of teaching: stage-1 approver for teaching staff requests.
  head_teacher: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "class.read", "enrollment.read", "attendance.read", "grade.read", "subject.selection.approve",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.head",
    "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Head of administration: stage-1 approver for non-teaching staff requests.
  head_admin: ["hr.self", "task.assign", "task.participate", "poll.vote", "discussion.participate", "discipline.file", "form.respond",
    "workflow.create", "workflow.read", "workflow.review", "workflow.review.head",
    "document.read", "notification.read", "notification.send", "security.elevation.request",
    "message.read", "message.send", "event.read", "announcement.read",
  ],
  // Hostel warden — manages ONLY the hostel(s) they are assigned to (scoped in the
  // service by Hostel.wardenId). Basic staff comms + self-service.
  warden: ["hr.self", "hostel.read", "hostel.manage", "notification.read",
    "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Head warden — supervises EVERY hostel (module-wide scoping in HostelService);
  // fee runs they schedule are maker-checker (FEE_SCHEDULE workflow -> admin approves).
  head_warden: ["hr.self", "hostel.read", "hostel.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Transport driver — reads ONLY their own vehicle / route / passengers (scoped in
  // the service by Vehicle.driverId). Read-only on transport; basic staff comms.
  driver: ["hr.self", "transport.read", "notification.read",
    "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Head driver — manages the WHOLE fleet (vehicles/routes/assignments; module-wide
  // scoping in TransportService); fee runs are maker-checker like the head warden's.
  head_driver: ["hr.self", "transport.read", "transport.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
  // Librarian — owns the library module (catalogue, loans, fines, exports).
  librarian: ["hr.self", "library.read", "library.borrow", "library.manage", "workflow.create", "workflow.read",
    "notification.read", "message.read", "message.send", "event.read", "announcement.read", "task.participate",
  ],
};

/** Union of every permission granted by `roles` (unknown roles contribute none). */
export function permissionsForRoles(roles: readonly string[]): string[] {
  const out = new Set<string>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) out.add(p);
  return [...out];
}

// =============================================================================
// PLATFORM-TIER roles — never assignable, modifiable or even VISIBLE at school level
// =============================================================================
// A role is platform-tier if it carries ANY `platform.*` permission. Deriving
// this from the permission map (rather than hand-listing role names) is the
// point: `manager_admin` was added as a platform role long after the original
// hand-maintained denylist was written, and nobody updated the list — which
// left a school_admin/principal able to grant it, and with it seven
// CROSS-TENANT platform permissions. Any future platform role is now covered
// automatically, and the check fails safe.
//
// Only super_admin (the platform owner) administers these roles.
export const PLATFORM_TIER_ROLES: readonly string[] = Object.entries(ROLE_PERMISSIONS)
  .filter(([, perms]) => perms.some((p) => p.startsWith("platform.")))
  .map(([role]) => role);

/** True when `roleName` may only ever be administered by the platform owner. */
export function isPlatformTierRole(roleName: string): boolean {
  return PLATFORM_TIER_ROLES.includes(roleName);
}
