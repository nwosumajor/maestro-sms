// =============================================================================
// Standalone retention sweep — run as a SCHEDULED, short-lived task, NOT in the
// public API process.
// =============================================================================
// SECURITY: the purge needs the RLS-bypassing table-owner (migrate) credentials
// via DATABASE_RETENTION_URL. We deliberately do NOT give those to the long-lived,
// internet-facing API service. Instead EventBridge runs this one-shot task daily
// (see infrastructure/terraform/retention.tf). It boots a minimal Nest context
// with ONLY the retention providers — no HTTP, no Redis, no request handlers —
// invokes purgeAllSchools once, then exits. Golden Rule #4 / #5.
// =============================================================================

import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RETENTION_DATABASE } from "../integrity.constants";
import { RetentionDatabaseService } from "./retention-database.service";
import { IntegrityRetentionService } from "./integrity-retention.service";

@Module({
  providers: [
    { provide: RETENTION_DATABASE, useClass: RetentionDatabaseService },
    IntegrityRetentionService,
  ],
})
class RetentionCliModule {}

async function main(): Promise<void> {
  const logger = new Logger("RetentionCli");
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ["error", "warn", "log"],
  });
  try {
    const service = app.get(IntegrityRetentionService);
    const result = await service.purgeAllSchools("SCHEDULED");
    // A scheduled one-shot task's last line is the only thing anyone sees. Say
    // whether it swept nothing because there was nothing, or because it was
    // never configured to sweep at all.
    logger.log(
      result.skipped
        ? "Retention CLI: SKIPPED — no DATABASE_RETENTION_URL / DATABASE_MIGRATE_URL configured, nothing was purged."
        : `Retention CLI done: ${result.schools.length} schools swept, ${result.purged} rows purged.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  new Logger("RetentionCli").error(err);
  process.exit(1);
});
