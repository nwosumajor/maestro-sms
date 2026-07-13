// Role-category helpers for user pickers. Roles are data-driven (seeded), so
// "staff" is defined by EXCLUSION: any role that isn't a learner/guardian role.
// A new staff role added in the seed is automatically staff — no code change.

/** The two non-staff role names. Everything else (teacher, principal, warden,
 *  driver, librarian, hr_clerk, …) is a staff role. */
export const NON_STAFF_ROLE_NAMES = ["student", "parent"] as const;

/** Categories accepted by `GET /users?kind=` — server-side picker filtering so
 *  a staff picker never mixes in students/parents (and vice versa). */
export const USER_KINDS = ["staff", "teacher", "parent"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Categorise a user's role list for grouped pickers (announcements etc.).
 *  A user holding any staff role counts as staff. */
export function userCategory(roles: string[]): "staff" | "student" | "parent" {
  if (roles.some((r) => !NON_STAFF_ROLE_NAMES.includes(r as (typeof NON_STAFF_ROLE_NAMES)[number]))) return "staff";
  if (roles.includes("student")) return "student";
  return "parent";
}
