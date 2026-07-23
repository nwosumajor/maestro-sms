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
//   WITHIN-school — two people who share a name. Handled by ROLE:
//                   * STAFF refuse-and-ask — a colleague typing their login daily
//                     should not get a near-identical adams.james2; the admin uses
//                     a fuller name.
//                   * STUDENTS auto-suffix (adams.james2, ...) — shared names are
//                     the norm on a large roll, pupils get a printed slip, and
//                     blocking the import would force endless CSV edits.
// =============================================================================
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { generateLoginEmail, schoolSlugCandidates } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

export interface AllocateLoginEmailOptions {
  /** Identifiers already allocated in this uncommitted tx (bulk imports). */
  taken?: Set<string>;
  /**
   * STUDENTS: walk adams.james -> adams.james2 -> ... until one is free, so a
   * shared name never blocks the import. STAFF (default): refuse a clash with a
   * 409 telling the admin to use a fuller name — a colleague should not get a
   * near-identical login they type daily.
   */
  autoSuffix?: boolean;
}

export async function allocateLoginEmail(
  tx: TenantTx,
  fullName: string,
  schoolSlug: string,
  opts: AllocateLoginEmailOptions = {},
): Promise<string> {
  const taken = opts.taken ?? new Set<string>();

  // NOTE: the lookup runs under RLS, so it sees only THIS school — exactly right,
  // since a cross-school match cannot happen and must not be disclosed. The
  // INSERT is still wrapped by every caller: a race between two concurrent
  // imports beats any pre-check, and P2002 is the final guarantee.
  if (opts.autoSuffix) {
    for (let suffix = 0; suffix <= 500; suffix++) {
      const candidate = generateLoginEmail(fullName, schoolSlug, suffix);
      if (taken.has(candidate)) continue;
      const clash = await tx.user.findFirst({ where: { email: candidate }, select: { id: true } });
      if (!clash) {
        taken.add(candidate);
        return candidate;
      }
    }
    // 500 identically-named pupils in one school is not a roll; it is a bug.
    throw new ConflictException(`Could not allocate a login identifier for "${fullName}".`);
  }

  const email = generateLoginEmail(fullName, schoolSlug);
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
