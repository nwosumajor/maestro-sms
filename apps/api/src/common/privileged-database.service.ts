// =============================================================================
// PrivilegedDatabaseService — the ONE RLS-bypassing connection per process
// =============================================================================
// Several features legitimately need to act outside the least-privilege app role
// and its RLS scoping: cross-tenant operator governance + directory search +
// onboarding provisioning (request-handlers), and the scheduled dunning / HR-
// reminder / retention sweeps. Each of these previously opened its OWN
// PrismaClient — i.e. its own connection pool — so a single API process held up
// to half a dozen privileged pools, multiplying connections to RDS and risking
// max_connections exhaustion on Fargate.
//
// This is the SINGLE shared privileged client for the process. It connects as the
// privileged migration role (DATABASE_MIGRATE_URL) which has the full rights the
// in-process consumers need (creating schools/users across tenants for
// provisioning, deleting append-only telemetry for the in-process sweeps), and
// falls back to DATABASE_RETENTION_URL — so the dedicated, least-privilege
// retention CLI task (which sets only RETENTION_URL) still uses its narrow role.
//
// // SECURITY: it bypasses RLS by design and is injected ONLY into the privileged
// services above — never reachable from an ordinary request handler. With no
// privileged URL the client is null and every consumer DISABLES (503 / no-op)
// rather than silently escalating (least-privilege default).
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@sms/db";

@Injectable()
export class PrivilegedDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("PrivilegedDatabase");
  private _client: PrismaClient | null = null;

  onModuleInit(): void {
    const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_RETENTION_URL;
    if (!url) {
      this.logger.warn(
        "No DATABASE_MIGRATE_URL / DATABASE_RETENTION_URL set — privileged " +
          "operations (operator/directory/provisioning + scheduled sweeps) are DISABLED.",
      );
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
    this.logger.log("Shared privileged DB client initialised.");
  }

  /** The privileged client, or null when no privileged URL is configured. */
  get client(): PrismaClient | null {
    return this._client;
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }
}
