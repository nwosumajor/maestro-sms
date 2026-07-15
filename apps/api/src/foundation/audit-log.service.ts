import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { currentImpersonator } from "../auth/request-context";
import type {
  AuditEntry,
  AuditLogService as IAuditLogService,
  TenantTx,
} from "../integrity/integrity.foundation";

/**
 * Durable, append-only audit log (Golden Rule #5). Writes to the `audit_log`
 * table INSIDE the caller's active tenant transaction, so the entry shares the
 * transaction's RLS context and atomicity with the mutation it records. The RLS
 * migration grants INSERT/SELECT only — entries can never be altered.
 *
 * IMPERSONATION: when the platform owner acts THROUGH a user, the principal — and
 * so `actorId` — genuinely is that user (same tenant/roles/RLS). Left alone, the
 * trail would read "the parent did this", hiding the owner completely. Every entry
 * therefore picks up `impersonatedBy` from the request context automatically, so
 * no call site can forget it and no impersonated action is unattributable.
 */
@Injectable()
export class AuditLogService implements IAuditLogService {
  private readonly logger = new Logger("AuditLog");

  async record(entry: AuditEntry, tx?: TenantTx): Promise<void> {
    if (!tx) {
      // Every mutation path passes the active tx; a missing one is a bug, not a
      // reason to silently lose the audit record.
      this.logger.error(
        `Audit entry without a transaction (dropped): ${entry.action} ${entry.entity}/${entry.entityId}`,
      );
      return;
    }
    // Stamp the real actor when this request is an impersonation. Taken from the
    // request context (set by the guard, the only place the token is verified) —
    // never from the caller, so it cannot be forgotten or forged.
    const impersonatedBy = currentImpersonator();
    const metadata = impersonatedBy
      ? { ...(entry.metadata ?? {}), impersonatedBy }
      : entry.metadata;
    await tx.auditLog.create({
      data: {
        schoolId: entry.schoolId,
        actorId: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        // Audit metadata is arbitrary JSON; assert Prisma's JSON-input type.
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
