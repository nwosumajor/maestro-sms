// =============================================================================
// A leaver's academic documents are the principal's to release
// =============================================================================
// Schools commonly hold a transcript or a leaving certificate until the family
// has settled what they owe. The platform had no way to record that decision, so
// it lived in somebody's head or nowhere at all.
//
// GATES ACADEMIC ARTEFACTS ONLY — transcript, report card, certificate. It
// deliberately does NOT gate the data-protection export. A data subject's right
// to their own personal data is not a debt-collection lever, and withholding it
// over money is unlawful rather than merely firm. That distinction is the whole
// reason this is a narrow helper and not a blanket check on the pupil.
//
// A PLAIN FUNCTION, not an injected service. The two callers live in
// ReportCardModule and CertificateModule; wiring them to LmsModule to reach a
// method would add module edges for a single `user` lookup, and a cycle in the
// Nest graph is the failure that typecheck, unit tests and the web build all
// stay green through — it only shows up as a container that will not boot.
// =============================================================================

import { ForbiddenException } from "@nestjs/common";
import type { TenantTx } from "../integrity/integrity.foundation";

/**
 * Throws when the subject has LEFT and their documents are still withheld.
 *
 * A pupil still at the school is never gated: report cards go out every term and
 * nothing here should touch that.
 */
export async function assertDocumentsReleasable(tx: TenantTx, studentId: string): Promise<void> {
  const u = await tx.user.findFirst({
    where: { id: studentId },
    select: { status: true, docsReleasedAt: true, name: true },
  });
  if (!u || u.status !== "EXITED" || u.docsReleasedAt) return;
  throw new ForbiddenException(
    `${u.name} has left the school and their documents have not been released. ` +
      `The principal releases them from the leavers page once any outstanding balance is settled.`,
  );
}
