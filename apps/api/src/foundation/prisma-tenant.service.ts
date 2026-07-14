import { Injectable } from "@nestjs/common";
import { prisma, readPrisma } from "@sms/db";
import type {
  TenantContext,
  TenantDatabase,
  TenantTx,
} from "../integrity/integrity.foundation";

/**
 * Concrete TenantDatabase: opens a transaction and sets the request-scoped GUCs
 * RLS reads, so EVERY statement inside `fn` is tenant-isolated — including in the
 * BullMQ worker, which has no HTTP request. // SECURITY: this is the only path to
 * the DB; we never hand out a client without tenant context set.
 */
@Injectable()
export class PrismaTenantService implements TenantDatabase {
  async runAsTenant<T>(
    ctx: TenantContext,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      // set_config(..., true) => LOCAL to this transaction. Parameterized.
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
      return fn(tx as unknown as TenantTx);
    });
  }

  /**
   * Read-only, replica-routed variant. Uses the read client (a replica when
   * `DATABASE_REPLICA_URL` is set, else the primary) and marks the transaction
   * READ ONLY so a stray write in a read path fails fast even on the primary
   * fallback. `SET TRANSACTION READ ONLY` must precede the first query, so it
   * runs before the GUC set_config calls.
   */
  async runAsTenantReadOnly<T>(
    ctx: TenantContext,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return readPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
      return fn(tx as unknown as TenantTx);
    });
  }
}
