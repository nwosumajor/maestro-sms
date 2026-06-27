import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@sms/db";

/**
 * Privileged DB handle used ONLY by the cross-tenant staff-document expiry sweep.
 *
 * // SECURITY: the sweep must read EVERY school's staff_document — a cross-tenant
 * read the least-privilege app role (FORCE RLS, single-tenant GUC) cannot do.
 * Like the dunning/retention jobs it connects as the dedicated retention role
 * (DATABASE_RETENTION_URL) — or, locally, the migration role
 * (DATABASE_MIGRATE_URL) — which bypasses RLS by design. Injected ONLY into
 * StaffReminderService; never reachable from a request handler. With no privileged
 * URL the client is null and the daily sweep is DISABLED (no-ops). It only ever
 * stamps reminderSentAt + creates in-app notifications — never deletes data.
 */
@Injectable()
export class HrReminderDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("HrReminderDatabase");
  private _client: PrismaClient | null = null;

  onModuleInit(): void {
    const url = process.env.DATABASE_RETENTION_URL ?? process.env.DATABASE_MIGRATE_URL;
    if (!url) {
      this.logger.warn("No DATABASE_RETENTION_URL / DATABASE_MIGRATE_URL — staff reminder sweep DISABLED.");
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
  }

  get client(): PrismaClient | null {
    return this._client;
  }

  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }
}
