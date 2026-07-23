// =============================================================================
// Allocating admission numbers
// =============================================================================
// Shared by BULK student import and MANUAL single-student creation so the two
// behave identically: a blank admission number is generated as <year>/NNNN,
// sequential within the school. The DB backstops uniqueness
// (@@unique([schoolId, admissionNumber])).
// =============================================================================
import { formatAdmissionNumber, nextAdmissionSeq } from "@sms/types";
import type { TenantTx } from "../integrity/integrity.foundation";

/** Every admission number already in use in this school (RLS-scoped). */
export async function loadUsedAdmissionNumbers(tx: TenantTx): Promise<Set<string>> {
  const rows = await tx.studentProfile.findMany({
    where: { admissionNumber: { not: null } },
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
