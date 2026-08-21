import { Injectable } from "@nestjs/common";
import { prisma, readPrisma } from "@sms/db";
import type {
  TenantContext,
  TenantDatabase,
  TenantTx,
} from "../integrity/integrity.foundation";
import { ReplicaRouterService, SINGLE_DATABASE_ROUTER } from "./replica-router.service";

/**
 * Concrete TenantDatabase: opens a transaction and sets the request-scoped GUCs
 * RLS reads, so EVERY statement inside `fn` is tenant-isolated — including in the
 * BullMQ worker, which has no HTTP request. // SECURITY: this is the only path to
 * the DB; we never hand out a client without tenant context set.
 */
@Injectable()
export class PrismaTenantService implements TenantDatabase {
  // The default is the inert single-database router, which is what a test that
  // never configured a replica actually wants; Nest injects the real one.
  constructor(private readonly router: ReplicaRouterService = SINGLE_DATABASE_ROUTER) {}

  async runAsTenant<T>(
    ctx: TenantContext,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    // WHETHER THIS TRANSACTION WROTE, asked inside it.
    //
    // Only a WRITE owes its author a fresh read, and most callers of this method
    // only read. `txid_current_if_assigned()` answers it exactly: Postgres
    // assigns a real transaction id the moment a transaction modifies anything,
    // and never for a pure read. Cheaper and more honest than guessing from the
    // method name, and it needs no cooperation from 100+ services.
    //
    // The whole block is skipped when no replica is configured, so a
    // single-database deployment pays nothing at all for this.
    let wrote = false;
    const out = await prisma.$transaction(async (tx) => {
      // set_config(..., true) => LOCAL to this transaction. Parameterized.
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
      const result = await fn(tx as unknown as TenantTx);
      if (this.router.configured) {
        const rows = (await tx.$queryRawUnsafe(
          "SELECT txid_current_if_assigned() IS NOT NULL AS wrote",
        )) as Array<{ wrote: boolean }>;
        wrote = rows[0]?.wrote === true;
      }
      return result;
    });
    if (wrote && ctx.userId) {
      // AFTER the commit, on purpose. Read inside the transaction, the WAL
      // position would be from before our own commit record, and a replica that
      // had replayed exactly that far would still be missing this write — which
      // is the failure this exists to prevent, reintroduced one statement early.
      try {
        const rows = (await prisma.$queryRawUnsafe("SELECT pg_current_wal_lsn()::text AS lsn")) as Array<{ lsn: string }>;
        if (rows[0]?.lsn) await this.router.noteWrite(ctx.userId, rows[0].lsn);
      } catch {
        // Never fail a committed write because the bookkeeping for the NEXT read
        // did not happen. The cost of losing it is one possibly-stale read.
      }
    }
    return out;
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
    // The replica answers this read only if it is fit to AND has caught up with
    // anything this user has just written. Otherwise the primary does, which is
    // always correct and merely more loaded — the right direction to fail.
    const { replica } = await this.router.useReplica(ctx.userId ?? null);
    const client = replica ? readPrisma : prisma;
    return client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
      return fn(tx as unknown as TenantTx);
    });
  }
}
