import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@sms/db";
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
    await tx.auditLog.create({
      data: {
        schoolId: entry.schoolId,
        actorId: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        // Audit metadata is arbitrary JSON; assert Prisma's JSON-input type.
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
