// Shared people-picker labelling: a staff dropdown shows "Name — Role" so a
// principal/school admin picking someone for a duty never has to memorize who
// holds which role. Works on any object that MAY carry `roles` (the /users
// directory returns them; plain IdName lists just show the name).

/** "hr_manager" -> "HR Manager", "school_admin" -> "School Admin", … */
export function roleLabel(role: string): string {
  const ACRONYMS = new Set(["hr"]);
  return role
    .split("_")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Option label for a person: name plus their role(s) when known. Student and
 *  parent are omitted from MIXED lists only when the person also holds a staff
 *  role (a teacher who is also a parent reads "Teacher", not both). */
export function personLabel(p: { name: string; roles?: readonly string[] }): string {
  const roles = p.roles ?? [];
  if (roles.length === 0) return p.name;
  const staffRoles = roles.filter((r) => r !== "student" && r !== "parent");
  const shown = staffRoles.length > 0 ? staffRoles : roles;
  return `${p.name} — ${shown.map(roleLabel).join(", ")}`;
}
