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
    const results = await service.purgeAllSchools("SCHEDULED");
    logger.log(`Retention CLI done: ${results.length} schools swept.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  new Logger("RetentionCli").error(err);
  process.exit(1);
});
