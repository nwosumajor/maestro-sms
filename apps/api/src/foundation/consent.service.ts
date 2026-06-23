import { Injectable } from "@nestjs/common";
import type {
  ConsentService as IConsentService,
  TenantTx,
} from "../integrity/integrity.foundation";

/**
 * NDPR consent for integrity telemetry on a minor (Golden Rule #5). Reads the
 * `integrity_consent` table inside the caller's tenant transaction (RLS-scoped
 * to the school), returning true only when an ACTIVE (not revoked) consent row
 * exists for the student. // SECURITY: fails closed — no row => no consent.
 */
@Injectable()
export class ConsentService implements IConsentService {
  async hasIntegrityConsent(
    args: { studentId: string; schoolId: string },
    tx: TenantTx,
  ): Promise<boolean> {
    const consent = await tx.integrityConsent.findFirst({
      where: { studentId: args.studentId, revokedAt: null },
      select: { id: true },
    });
    return Boolean(consent);
  }
}
