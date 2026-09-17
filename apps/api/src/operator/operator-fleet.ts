// =============================================================================
// The fleet, as a PREDICATE — not as five thousand uuids
// =============================================================================
// Several cross-tenant operator reads want "every customer school". The obvious
// spelling is to fetch the ids once and interpolate them:
//
//     WHERE "schoolId" = ANY(ARRAY[${Prisma.join(customerIds)}]::uuid[])
//
// which at the 5,000-school target is a 195 KB SQL string that Postgres must
// receive and parse on every call. Measured against the equivalent subquery on
// that fixture: 12.7 ms planning / 33.3 ms execution, versus 4.2 / 20.6 — twice
// the cost, and it is the PLANNING half that grows with the fleet, so it gets
// worse at 50,000 exactly where it is least affordable.
//
// The id list is still needed in Node (it keys the per-school roll-ups), so this
// does not replace the fetch; it stops the fetch being SPELLED OUT to the server
// a second time for each aggregate.
//
// SECURITY: these run on the PRIVILEGED client by design — they are the platform
// owner's own cross-tenant reads, already gated by a platform permission and
// audited. The predicate is a literal fragment with no caller input in it, so it
// cannot widen a scope or carry an injection; a caller choosing the wrong one
// narrows or widens to the OTHER documented fleet, never outside it.
// =============================================================================

// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";

/** Every customer school, whatever its status. Excludes the platform org. */
export const ALL_CUSTOMER_SCHOOLS = Prisma.sql`SELECT id FROM school WHERE "isPlatform" = false`;

/** Customer schools still switched on. A DISABLED tenant is not worth chasing. */
export const ACTIVE_CUSTOMER_SCHOOLS = Prisma.sql`SELECT id FROM school WHERE "isPlatform" = false AND status = 'ACTIVE'`;

/**
 * Which schools a cross-tenant read covers: an explicit list (a PAGE of schools,
 * where the caller has already decided which) or one of the fleet predicates.
 */
export type SchoolScope = readonly string[] | Prisma.Sql;

/** True when the scope selects nothing at all, so the caller can return early
 *  rather than hand `Prisma.join` an empty array (which throws). */
export function isEmptyScope(scope: SchoolScope): boolean {
  return Array.isArray(scope) && scope.length === 0;
}

/**
 * `<column> <in the scope>` as a SQL fragment.
 *
 * ONE spelling of the filter, so a call site that pages and a call site that
 * sweeps the fleet cannot drift into disagreeing about what "this school is in
 * scope" means — the sibling-asymmetry failure this codebase keeps meeting.
 */
export function inSchoolScope(column: Prisma.Sql, scope: SchoolScope): Prisma.Sql {
  return Array.isArray(scope)
    ? Prisma.sql`${column} = ANY(ARRAY[${Prisma.join([...scope])}]::uuid[])`
    : Prisma.sql`${column} IN (${scope as Prisma.Sql})`;
}
