// =============================================================================
// Allocating admission numbers
// =============================================================================
// Shared by BULK student import and MANUAL single-student creation so the two
// behave identically: a blank admission number is generated as <year>/NNNN,
// sequential within the school. The DB backstops uniqueness
// (@@unique([schoolId, admissionNumber])).
// =============================================================================
import { formatAdmissionNumber, nextAdmissionSeq, resolveRegion, schoolToday } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Admission numbers already in use in this school (RLS-scoped).
 *
 * `forYear` scopes the load to that year's numbers via the indexed
 * `(schoolId, admissionNumber)` prefix — enough for GENERATION (which only ever
 * sequences and collides within the current year), and it keeps a single-student
 * create O(this-year's-intake) instead of O(all-students-ever). Omit it (bulk
 * import) to load every number, which is also needed to dedupe a school's own
 * custom, non-year-format numbers.
 */
export async function loadUsedAdmissionNumbers(tx: TenantTx, forYear?: number): Promise<Set<string>> {
  const rows = await tx.studentProfile.findMany({
    where: forYear ? { admissionNumber: { startsWith: `${forYear}/` } } : { admissionNumber: { not: null } },
    select: { admissionNumber: true },
  });
  return new Set(rows.map((r) => r.admissionNumber).filter(Boolean) as string[]);
}

/**
 * Next free `<year>/NNNN` for the school, given the used-set. MUTATES the set
 * (adds the allocated number) so repeated calls within one batch stay distinct.
 * A school's own custom numbers merely occupy the set and are skipped past.
 */
export function allocateAdmissionNumber(used: Set<string>, year: number): string {
  let seq = nextAdmissionSeq(used, year);
  let candidate = formatAdmissionNumber(year, seq);
  while (used.has(candidate)) {
    seq += 1;
    candidate = formatAdmissionNumber(year, seq);
  }
  used.add(candidate);
  return candidate;
}

/**
 * The year an admission number belongs to, on the SCHOOL's calendar.
 *
 * `new Date().getFullYear()` answers with the server's year, which in a
 * container is UTC. The number is a printed identifier — it goes on the ID card
 * and is what a clerk searches by — so getting the year wrong is a permanent
 * mislabelling of a pupil, not a display quirk. It bit at both ends: a pupil
 * enrolled on the evening of 31 December in Toronto (UTC-4) was stamped with the
 * NEXT year, and one enrolled before 08:00 on 1 January in Singapore (UTC+8)
 * with the LAST. January is the start of the academic year for six of the
 * catalogued countries, so that boundary is not a quiet time of year.
 *
 * Read here rather than through SchoolRegionService so the two call sites need
 * no new constructor dependency; the app role has SELECT on `school`, and this
 * only runs when a number is actually being allocated.
 */
export async function schoolAdmissionYear(tx: TenantTx, schoolId: string): Promise<number> {
  const school = (await tx.school.findFirst({
    where: { id: schoolId },
    select: { country: true, timezone: true },
  })) as { country: string | null; timezone: string | null } | null;
  // A null region means the platform's home country, never "unknown".
  return schoolToday(resolveRegion(school ?? {}).timezone).getUTCFullYear();
}
