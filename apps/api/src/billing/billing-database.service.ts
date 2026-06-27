import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@sms/db";

/**
 * The privileged DB handle used ONLY by the cross-tenant dunning sweep.
 *
 * // SECURITY: the dunning sweep must read EVERY school's subscription and flip
 * overdue ones to PAST_DUE — a cross-tenant operation the least-privilege app
 * role (`major_user`, FORCE RLS, single-tenant GUC) cannot perform. Like the
 * integrity retention purge, it connects as the dedicated retention role
 * (DATABASE_RETENTION_URL) — or, locally, the migration superuser
 * (DATABASE_MIGRATE_URL) — which bypasses RLS by design. It is injected ONLY into
 * BillingDunningService and is NEVER reachable from a request handler.
 *
 * Least-privilege default: with no privileged URL configured the client is null
 * and dunning is DISABLED (it no-ops) rather than silently escalating. The sweep
 * only ever flips a status column / sends reminders — it never deletes data.
 */
@Injectable()
export class BillingDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("BillingDatabase");
  private _client: PrismaClient | null = null;

  onModuleInit(): void {
    const url = process.env.DATABASE_RETENTION_URL ?? process.env.DATABASE_MIGRATE_URL;
    if (!url) {
      this.logger.warn(
        "No DATABASE_RETENTION_URL / DATABASE_MIGRATE_URL set — billing dunning " +
          "sweep is DISABLED (least-privilege default).",
      );
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
    this.logger.log("Privileged dunning DB client initialised.");
  }

  /** The privileged client, or null when dunning is disabled. */
  get client(): PrismaClient | null {
    return this._client;
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }
}
