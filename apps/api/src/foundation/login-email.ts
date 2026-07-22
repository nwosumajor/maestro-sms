// =============================================================================
// Allocating a login identifier
// =============================================================================
// Pairs the pure generator in @sms/types with the one thing it cannot do: ask
// the database whether a candidate is free.
//
// WHY THE LOOKUP IS DELIBERATELY UNSCOPED
// The uniqueness constraint on user.email is GLOBAL, so a same-school-only check
// would pass and the INSERT would still fail. Callers run inside runAsTenant,
// where RLS hides other schools — so we cannot see a clash by querying rows.
// Instead we rely on the generator: the school's own unique slug is the
// subdomain, so a cross-school clash is impossible BY CONSTRUCTION and the only
// clash left to resolve is two real people sharing a name in the SAME school —
// which the tenant-scoped query can see perfectly well.
//
// The INSERT is still wrapped by every caller: a race between two concurrent
// imports can slip past any pre-check, and P2002 is the only real guarantee.
// =============================================================================
import { loginEmailCandidates } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * First free `first.last@<slug>.<domain>` for this person in this school.
 *
 * `taken` lets a bulk import pass the addresses it has already allocated inside
 * the same transaction but not yet committed — without it, importing two pupils
 * called Adams James in one file would hand both the same identifier.
 */
export async function allocateLoginEmail(
  tx: TenantTx,
  fullName: string,
  schoolSlug: string,
  taken: Set<string> = new Set(),
): Promise<string> {
  const candidates = loginEmailCandidates(fullName, schoolSlug, 50);
  for (const candidate of candidates) {
    if (taken.has(candidate)) continue;
    const clash = await tx.user.findFirst({ where: { email: candidate }, select: { id: true } });
    if (!clash) {
      taken.add(candidate);
      return candidate;
    }
  }
  // 50 people with the same name in one school is not a real roll; it is a bug
  // or an attack. Fail loudly rather than inventing something unpredictable.
  throw new Error(`Could not allocate a login identifier for "${fullName}" at "${schoolSlug}"`);
}

/** The school's slug, needed for the subdomain. Cheap and cached by the caller. */
export async function schoolSlugOf(tx: TenantTx, schoolId: string): Promise<string> {
  const school = await tx.school.findFirst({ where: { id: schoolId }, select: { slug: true } });
  if (!school) throw new Error("School not found");
  return school.slug;
}
