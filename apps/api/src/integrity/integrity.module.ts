// =============================================================================
// IntegrityModule
// =============================================================================
// Wires the controller, service, and BullMQ worker. The three foundation
// dependencies (TENANT_DATABASE, AUDIT_LOG_SERVICE, CONSENT_SERVICE) and the
// optional EMBEDDING_PROVIDER are bound here. In the real app they resolve to the
// foundation's existing providers — placeholders below show the contract.
// =============================================================================

import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import {
  INTEGRITY_QUEUE,
  INTEGRITY_RETENTION_QUEUE,
  CONSENT_SERVICE,
  EMBEDDING_PROVIDER,
  RETENTION_DATABASE,
} from "./integrity.constants";
import { AUDIT_LOG_SERVICE, TENANT_DATABASE } from "./integrity.foundation";
import { IntegrityController } from "./integrity.controller";
import { IntegrityService } from "./integrity.service";
import { IntegrityProcessor } from "./integrity.processor";
import { IntegrityReportController } from "./integrity-report.controller";
import { IntegrityReportService } from "./integrity-report.service";
import { AssessmentTakeController } from "./assessment-take.controller";
import { RetentionDatabaseService } from "./retention/retention-database.service";
import { IntegrityRetentionService } from "./retention/integrity-retention.service";
import { IntegrityRetentionProcessor } from "./retention/integrity-retention.processor";
import { IntegrityRetentionScheduler } from "./retention/integrity-retention.scheduler";
import { IntegrityRetentionController } from "./retention/integrity-retention.controller";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: INTEGRITY_QUEUE },
      { name: INTEGRITY_RETENTION_QUEUE },
    ),
  ],
  controllers: [
    IntegrityController,
    IntegrityReportController,
    AssessmentTakeController,
    IntegrityRetentionController,
  ],
  providers: [
    IntegrityService,
    IntegrityReportService,
    IntegrityProcessor,
    // --- Retention / NDPR purge (Golden Rule #5). Privileged DB is bound here;
    //     the scheduler registers the daily repeatable sweep on boot. ---
    { provide: RETENTION_DATABASE, useClass: RetentionDatabaseService },
    IntegrityRetentionService,
    IntegrityRetentionProcessor,
    IntegrityRetentionScheduler,
    // --- Bind foundation contracts here at integration ---
    // { provide: TENANT_DATABASE,    useExisting: PrismaTenantService },
    // { provide: AUDIT_LOG_SERVICE,  useExisting: AuditLogService },
    // { provide: CONSENT_SERVICE,    useExisting: NdprConsentService },
    // EMBEDDING_PROVIDER is OPTIONAL — omit to disable prose similarity:
    // { provide: EMBEDDING_PROVIDER, useExisting: EmbeddingsService },
  ],
  exports: [IntegrityService, IntegrityReportService],
})
export class IntegrityModule {
  // Tokens referenced so integrators see exactly what must be provided.
  static readonly REQUIRED_PROVIDERS = [
    TENANT_DATABASE,
    AUDIT_LOG_SERVICE,
    CONSENT_SERVICE,
  ] as const;
  static readonly OPTIONAL_PROVIDERS = [EMBEDDING_PROVIDER] as const;
}
