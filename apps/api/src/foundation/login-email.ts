// =============================================================================
// Allocating login identifiers and school slugs
// =============================================================================
// Pairs the pure generators in @sms/types with the one thing they cannot do:
// ask the database whether a candidate is free.
//
// TWO different collisions, deliberately handled in opposite ways:
//
//   CROSS-school  — impossible by construction. school.slug is UNIQUE, and the
//                   slug is the domain, so adams.james@maestro.com and
//                   adams.james@standrews.com simply cannot clash.
//
//   WITHIN-school — two real colleagues who share a name. NOT auto-suffixed:
//                   the administrator is told, and picks a fuller name. Silently
//                   minting `adams.james2` would give two colleagues near-identical
//                   logins and invite years of sign-in mistakes and misfiled work.
// =============================================================================
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { generateLoginEmail, schoolSlugCandidates } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * `firstname.lastname@<slug>.com` for this person, or a 409 telling the
 * administrator the name is already taken IN THIS SCHOOL.
 *
 * `taken` carries identifiers already allocated inside the same transaction but
 * not yet committed — without it, one CSV containing two pupils called Adams
 * James would hand both the same identifier.
 */
export async function allocateLoginEmail(
  tx: TenantTx,
  fullName: string,
  schoolSlug: string,
  taken: Set<string> = new Set(),
): Promise<string> {
  const email = generateLoginEmail(fullName, schoolSlug);

  // NOTE: this lookup runs under RLS, so it sees only THIS school. That is
  // exactly right — a cross-school match cannot happen, and if it somehow did we
  // must not disclose it. The INSERT is still wrapped by every caller: a race
  // between two concurrent imports beats any pre-check, and P2002 is the only
  // real guarantee.
  const clash = taken.has(email) || (await tx.user.findFirst({ where: { email }, select: { id: true } }));
  if (clash) {
    throw new ConflictException(
      `The name "${fullName}" already exists in this school (${email} is taken). ` +
        `Use a fuller name — for example include a middle name — or set the sign-in email manually.`,
    );
  }

  taken.add(email);
  return email;
}

/** Translate a racing INSERT into the same message the pre-check would have given. */
export function asNameTakenConflict(e: unknown, fullName: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new ConflictException(
      `The name "${fullName}" already exists in this school. ` +
        `Use a fuller name — for example include a middle name — or set the sign-in email manually.`,
    );
  }
  throw e as Error;
}

/** The school's slug — the login domain. Callers cache it across a bulk import. */
export async function schoolSlugOf(tx: TenantTx, schoolId: string): Promise<string> {
  const school = await tx.school.findFirst({ where: { id: schoolId }, select: { slug: true } });
  if (!school) throw new Error("School not found");
  return school.slug;
}

/**
 * A SHORT slug not yet used by any school. Requires a client that can see ALL
 * schools (the privileged one) — `school` is a global, RLS-exempt table and a
 * tenant-scoped read would happily hand out a slug another school already owns.
 */
export async function allocateSchoolSlug(
  client: { school: { findFirst(args: unknown): Promise<{ id: string } | null> } },
  schoolName: string,
): Promise<string> {
  for (const candidate of schoolSlugCandidates(schoolName)) {
    const taken = await client.school.findFirst({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new ConflictException(
    `Could not derive a unique short slug for "${schoolName}". Please supply one explicitly.`,
  );
}
