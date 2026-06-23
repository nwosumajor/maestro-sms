import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@sms/db";

/**
 * The privileged DB handle used ONLY by the retention/purge job.
 *
 * // SECURITY: this is the single privileged (RLS-bypassing) connection in the
 * API process. The least-privilege app role (`major_user`) deliberately has NO
 * DELETE on the append-only integrity telemetry, so the purge cannot run as the
 * app role. This client connects as the dedicated retention role
 * (DATABASE_RETENTION_URL) — or, locally, the migration superuser
 * (DATABASE_MIGRATE_URL) — which bypasses RLS by design so a single sweep can
 * prune expired rows across every tenant. It is injected ONLY into
 * IntegrityRetentionService and is NEVER reachable from a request handler.
 *
 * Least-privilege default: if no privileged URL is configured, the client is
 * null and retention is DISABLED (it no-ops) rather than silently escalating.
 */
@Injectable()
export class RetentionDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("RetentionDatabase");
  private _client: PrismaClient | null = null;

  onModuleInit(): void {
    const url =
      process.env.DATABASE_RETENTION_URL ?? process.env.DATABASE_MIGRATE_URL;
    if (!url) {
      this.logger.warn(
        "No DATABASE_RETENTION_URL / DATABASE_MIGRATE_URL set — integrity " +
          "retention purge is DISABLED (least-privilege default).",
      );
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
    this.logger.log("Privileged retention DB client initialised.");
  }

  /** The privileged client, or null when retention is disabled. */
  get client(): PrismaClient | null {
    return this._client;
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }
}
