import { Inject, Injectable } from "@nestjs/common";
import { LEGAL_DOCS_VERSION } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

@Injectable()
export class LegalService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  /** Whether the school has an acceptance row for the CURRENT pack version. */
  async status(p: Principal): Promise<{ currentVersion: string; accepted: boolean; acceptedAt: Date | null }> {
    const row = await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      tx.legalAcceptance.findFirst({
        where: { schoolId: p.schoolId, docVersion: LEGAL_DOCS_VERSION },
        orderBy: { acceptedAt: "asc" },
      }),
    );
    return { currentVersion: LEGAL_DOCS_VERSION, accepted: !!row, acceptedAt: row?.acceptedAt ?? null };
  }

  /** Append one acceptance row (idempotent per version-per-school in effect —
   *  extra rows are harmless extra evidence) and audit it. */
  async accept(p: Principal, docVersion: string, context: "IN_APP" | "ONBOARDING") {
    return this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, async (tx) => {
      const row = await tx.legalAcceptance.create({
        data: { schoolId: p.schoolId, userId: p.userId, docVersion, context },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "legal.accept",
          entity: "legal_acceptance",
          entityId: row.id,
          schoolId: p.schoolId,
          metadata: { docVersion, context },
        },
        tx,
      );
      return { accepted: true as const, docVersion, acceptedAt: row.acceptedAt };
    });
  }
}
