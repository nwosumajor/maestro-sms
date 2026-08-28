// Role-category helpers for user pickers. Roles are data-driven (seeded), so
// "staff" is defined by EXCLUSION: any role that isn't a learner/guardian role.
// A new staff role added in the seed is automatically staff — no code change.

/** The two non-staff role names. Everything else (teacher, principal, warden,
 *  driver, librarian, hr_clerk, …) is a staff role. */
export const NON_STAFF_ROLE_NAMES = ["student", "parent"] as const;

/**
 * Is this principal a member of staff?
 *
 * The one answer to a question three files spelled three ways. Two of the
 * spellings were exclusions and equivalent; the third was an ALLOW-LIST of six
 * role names in the calendar, and it had rotted exactly as the header above
 * predicts — nine staff roles (head_teacher, hr_manager, librarian, warden,
 * head_warden, driver, head_driver, junior_admin, head_admin) were added to the
 * platform after it was written and none was added to it, so a STAFF-audience
 * calendar event was invisible to all of them.
 *
 * An allow-list has to be edited when a role is added and nothing makes that
 * happen. An exclusion does not, which is the whole reason this module defines
 * staff by exclusion in the first place.
 *
 * A principal holding NO roles is not staff — the restrictive answer, and the
 * one that keeps an unroled account out of staff-only content.
 */
export function isStaffRoles(roles: readonly string[]): boolean {
  return roles.some((r) => !(NON_STAFF_ROLE_NAMES as readonly string[]).includes(r));
}

/** Platform-level roles: they belong to the operator's own org, never to a
 *  customer school, so a school's headcount must never include them. */
export const PLATFORM_ROLE_NAMES = ["super_admin", "manager_admin"] as const;

/**
 * Roles excluded from a SCHOOL's staff headcount.
 *
 * "Staff" is defined by EXCLUSION on purpose: a role added to the seed tomorrow is
 * staff without a code change. The operator console previously carried its OWN
 * hand-written allow-list of nine role names, which silently omitted warden,
 * driver, head_warden, head_driver, librarian and junior_admin — so every boarding
 * school and every school with a librarian reported fewer staff than it employed,
 * and nothing looked broken. An audit figure that quietly under-reports is worse
 * than no figure, because it gets believed.
 */
export const NON_SCHOOL_STAFF_ROLE_NAMES = [...NON_STAFF_ROLE_NAMES, ...PLATFORM_ROLE_NAMES] as const;

/** Categories accepted by `GET /users?kind=` — server-side picker filtering so
 *  a staff picker never mixes in students/parents (and vice versa). */
// "meeting-host" is staff NARROWED to those who can actually open the meetings
// page. A picker that offers a colleague the endpoint will then refuse is the
// same defect as an audience picker offering a scope you may not address.
export const USER_KINDS = ["staff", "teacher", "parent", "meeting-host"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Categorise a user's role list for grouped pickers (announcements etc.).
 *  A user holding any staff role counts as staff. */
export function userCategory(roles: string[]): "staff" | "student" | "parent" {
  if (roles.some((r) => !NON_STAFF_ROLE_NAMES.includes(r as (typeof NON_STAFF_ROLE_NAMES)[number]))) return "staff";
  if (roles.includes("student")) return "student";
  return "parent";
}
