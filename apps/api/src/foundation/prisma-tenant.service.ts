import { Injectable } from "@nestjs/common";
import { prisma } from "@sms/db";
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
}
