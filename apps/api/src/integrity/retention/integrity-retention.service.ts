import { Inject, Injectable, Logger } from "@nestjs/common";
import { RETENTION_DATABASE } from "../integrity.constants";
import { RetentionDatabaseService } from "./retention-database.service";

export type RetentionTrigger = "SCHEDULED" | "MANUAL";

export interface SchoolRetentionResult {
  schoolId: string;
  retentionDays: number;
  cutoff: string;
  signalsDeleted: number;
  draftsDeleted: number;
  telemetryDeleted: number;
  /** Set when nothing was purged for a non-error reason. */
  skipped?: "DISABLED" | "NO_DB";
}

/**
 * Enforces the NDPR-aligned retention rule (Golden Rule #5): integrity TELEMETRY
 * on minors — integrity_signal / submission_draft / submission_telemetry — is
 * pruned once it is older than each school's configured window
 * (School.integrityRetentionDays). The reviewed academic record (submissions,
 * grades) is NOT touched here; only the integrity evidence/telemetry.
 *
 * Runs under the privileged retention client (see RetentionDatabaseService).
 * Every statement is explicitly scoped by schoolId, and each run writes an
 * immutable IntegrityRetentionRun record so the purge is itself auditable.
 */
@Injectable()
export class IntegrityRetentionService {
  private readonly logger = new Logger("IntegrityRetention");

  constructor(
    @Inject(RETENTION_DATABASE) private readonly db: RetentionDatabaseService,
  ) {}

  /** Sweep every tenant (the scheduled worker's entry point). */
  async purgeAllSchools(
    trigger: RetentionTrigger = "SCHEDULED",
  ): Promise<SchoolRetentionResult[]> {
    const client = this.db.client;
    if (!client) {
      this.logger.warn("Retention sweep requested but no privileged DB — skipping.");
      return [];
    }
    const schools = await client.school.findMany({
      select: { id: true, integrityRetentionDays: true },
    });
    const results: SchoolRetentionResult[] = [];
    for (const s of schools) {
      results.push(await this.purgeSchool(s.id, s.integrityRetentionDays, trigger));
    }
    const purged = results.reduce(
      (n, r) => n + r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted,
      0,
    );
    this.logger.log(
      `Retention sweep (${trigger}) complete: ${schools.length} schools, ${purged} rows purged.`,
    );
    return results;
  }

  /** Purge one school using its window. schoolId/retentionDays come from the
   *  registry, never from request input. */
  async purgeSchool(
    schoolId: string,
    retentionDays: number,
    trigger: RetentionTrigger = "MANUAL",
  ): Promise<SchoolRetentionResult> {
    const client = this.db.client;
    if (!client) {
      return {
        schoolId,
        retentionDays,
        cutoff: new Date().toISOString(),
        signalsDeleted: 0,
        draftsDeleted: 0,
        telemetryDeleted: 0,
        skipped: "NO_DB",
      };
    }
    // 0 / negative window => purging disabled for this school (keep everything).
    if (!retentionDays || retentionDays <= 0) {
      return {
        schoolId,
        retentionDays,
        cutoff: new Date().toISOString(),
        signalsDeleted: 0,
        draftsDeleted: 0,
        telemetryDeleted: 0,
        skipped: "DISABLED",
      };
    }

    const startedAt = new Date();
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    // One transaction: delete the three append-only tables for THIS school, then
    // write the immutable run record. // SECURITY: privileged (RLS-bypassing)
    // handle, so every delete is explicitly bounded by schoolId — no cross-tenant
    // bleed even without RLS.
    const counts = await client.$transaction(async (tx) => {
      const where = { schoolId, createdAt: { lt: cutoff } };
      const signals = await tx.integritySignal.deleteMany({ where });
      const drafts = await tx.submissionDraft.deleteMany({ where });
      const telemetry = await tx.submissionTelemetry.deleteMany({ where });
      await tx.integrityRetentionRun.create({
        data: {
          schoolId,
          retentionDays,
          cutoff,
          signalsDeleted: signals.count,
          draftsDeleted: drafts.count,
          telemetryDeleted: telemetry.count,
          trigger,
          startedAt,
        },
      });
      return { signals: signals.count, drafts: drafts.count, telemetry: telemetry.count };
    });

    // Counts only — never the purged evidence/content (no PII in logs).
    this.logger.log(
      `school=${schoolId} cutoff=${cutoff.toISOString()} purged ` +
        `signals=${counts.signals} drafts=${counts.drafts} telemetry=${counts.telemetry}`,
    );
    return {
      schoolId,
      retentionDays,
      cutoff: cutoff.toISOString(),
      signalsDeleted: counts.signals,
      draftsDeleted: counts.drafts,
      telemetryDeleted: counts.telemetry,
    };
  }
}
