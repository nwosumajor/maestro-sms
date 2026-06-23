// =============================================================================
// IntegrityService — ingestion, persistence, detection orchestration
// =============================================================================
// Security spine of the module. Every method here:
//  - runs inside a tenant transaction (RLS enforced, GR#2/#3),
//  - audit-logs the read or write (GR#5),
//  - returns 404 (never 403) for anything the caller can't see (no cross-tenant
//    or cross-owner existence leak — coding conventions),
//  - and NEVER takes punitive action. The only outputs are signals + telemetry
//    for human review (GR#8). There is deliberately no method that mutates a
//    grade, score, or student record.
// =============================================================================

import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@sms/db";
import { createHash } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type {
  ClientSignalBatch,
  TypingCadenceSample,
} from "@sms/types";
import {
  IntegritySignalSeverity,
  IntegritySignalSource,
  IntegritySignalType,
} from "@sms/types";
import {
  ANALYZE_SUBMISSION_JOB,
  CONSENT_SERVICE,
  INTEGRITY_QUEUE,
  type AnalyzeSubmissionJob,
  type IntegrityTrigger,
} from "./integrity.constants";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type ConsentService,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "./integrity.foundation";
import { buildDetectors } from "./detectors";
import type {
  EmbeddingProvider,
  NewSignal,
  PasteEvidence,
  SubmissionContext,
} from "./detectors";
import { EMBEDDING_PROVIDER } from "./integrity.constants";

@Injectable()
export class IntegrityService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    @Inject(CONSENT_SERVICE) private readonly consent: ConsentService,
    @InjectQueue(INTEGRITY_QUEUE) private readonly queue: Queue<AnalyzeSubmissionJob>,
    // Optional: prose similarity is skipped if no provider is bound.
    @Optional() @Inject(EMBEDDING_PROVIDER) private readonly embeddings?: EmbeddingProvider,
  ) {}

  // ---------------------------------------------------------------------------
  // Helper: load a submission the caller is allowed to act on, or 404.
  // ---------------------------------------------------------------------------
  private async loadOwnSubmission(tx: TenantTx, ctx: TenantContext, submissionId: string) {
    // RLS already restricts to ctx.schoolId; we additionally require ownership.
    const submission = await tx.submission.findFirst({
      where: { id: submissionId },
    });
    // SECURITY: 404 (not 403) whether it's cross-tenant (invisible via RLS) or
    // simply not the caller's submission — never leak that the row exists.
    if (!submission || submission.studentId !== ctx.userId) {
      throw new NotFoundException("Submission not found");
    }
    return submission;
  }

  // ---------------------------------------------------------------------------
  // 0. Load the take-context for a student: their (auto-created) submission plus
  //    the resolved integrity config (toggles + consent + active exemption). The
  //    web layer renders this verbatim; it never decides consent/exempt itself.
  // ---------------------------------------------------------------------------
  async getTakeContext(ctx: TenantContext, assessmentId: string) {
    return this.db.runAsTenant(ctx, async (tx) => {
      const assessment = await tx.assessment.findFirst({ where: { id: assessmentId } });
      if (!assessment) throw new NotFoundException("Assessment not found");

      let submission = await tx.submission.findFirst({
        where: { assessmentId, studentId: ctx.userId },
      });
      if (!submission) {
        submission = await tx.submission.create({
          data: {
            schoolId: ctx.schoolId,
            assessmentId,
            studentId: ctx.userId,
            status: "IN_PROGRESS",
          },
        });
        await this.audit.record(
          {
            actorId: ctx.userId,
            action: "integrity.submission.start",
            entity: "submission",
            entityId: submission.id,
            schoolId: ctx.schoolId,
          },
          tx,
        );
      }

      // Active exemption = not revoked, scoped to this assessment OR global (null).
      const exemption = await tx.studentIntegrityExemption.findFirst({
        where: {
          studentId: ctx.userId,
          revokedAt: null,
          OR: [{ assessmentId }, { assessmentId: null }],
        },
      });
      const consentGranted = await this.consent.hasIntegrityConsent(
        { studentId: ctx.userId, schoolId: ctx.schoolId },
        tx,
      );

      return {
        assessmentId,
        submissionId: submission.id,
        assessmentTitle: assessment.title,
        timeRemainingLabel: "—", // wired to scheduling later; out of scope here
        initialContent: submission.content ?? "",
        integrityEnabled: assessment.integrityEnabled,
        consentGranted,
        exempt: Boolean(exemption),
        toggles: {
          pasteCapture: assessment.pasteBlocked,
          focusTracking: assessment.focusTracked,
          typingCadence: assessment.typingTracked,
        },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Student posts CLIENT signals for their own in-progress submission.
  //    PASTE/FOCUS_LOSS -> append-only IntegritySignal (source CLIENT).
  //    TYPING_CADENCE   -> append-only SubmissionTelemetry (raw, not a signal).
  // ---------------------------------------------------------------------------
  async ingestClientSignals(ctx: TenantContext, batch: ClientSignalBatch): Promise<void> {
    await this.db.runAsTenant(ctx, async (tx) => {
      const submission = await this.loadOwnSubmission(tx, ctx, batch.submissionId);

      // Consent + master switch gate: drop telemetry rather than store it if the
      // school hasn't enabled integrity or we lack NDPR consent for this minor.
      const assessment = await tx.assessment.findFirst({
        where: { id: submission.assessmentId },
      });
      const consented = await this.consent.hasIntegrityConsent(
        { studentId: submission.studentId, schoolId: ctx.schoolId },
        tx,
      );
      if (!assessment?.integrityEnabled || !consented) {
        // SECURITY: no consent / monitoring off => we do not persist telemetry.
        return;
      }

      for (const sig of batch.signals) {
        if (sig.kind === "TYPING_CADENCE") {
          await tx.submissionTelemetry.create({
            data: {
              schoolId: ctx.schoolId,
              submissionId: submission.id,
              kind: "TYPING_CADENCE",
              payload: sig,
            },
          });
        } else {
          await tx.integritySignal.create({
            data: {
              schoolId: ctx.schoolId,
              submissionId: submission.id,
              type:
                sig.kind === "PASTE"
                  ? IntegritySignalType.PASTE
                  : IntegritySignalType.FOCUS_LOSS,
              source: IntegritySignalSource.CLIENT,
              // Client never assigns a real severity; raw events are INFO.
              severity: IntegritySignalSeverity.INFO,
              confidence: 0,
              evidence: sig,
              detector: "client-capture@v1",
            },
          });
        }
      }

      await this.audit.record(
        {
          actorId: ctx.userId,
          action: "integrity.signal.ingest",
          entity: "submission",
          entityId: submission.id,
          schoolId: ctx.schoolId,
          metadata: { count: batch.signals.length },
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Autosave: append an immutable draft snapshot, then enqueue detection.
  // ---------------------------------------------------------------------------
  async autosave(ctx: TenantContext, submissionId: string, content: string): Promise<void> {
    await this.db.runAsTenant(ctx, async (tx) => {
      const submission = await this.loadOwnSubmission(tx, ctx, submissionId);

      const last = await tx.submissionDraft.findFirst({
        where: { submissionId: submission.id },
        orderBy: { sequence: "desc" },
      });
      const sequence = (last?.sequence ?? 0) + 1;
      await tx.submissionDraft.create({
        data: {
          schoolId: ctx.schoolId,
          submissionId: submission.id,
          sequence,
          contentHash: createHash("sha256").update(content).digest("hex"),
          content,
        },
      });
      // Keep the working copy current so detectors compare the latest text.
      await tx.submission.update({
        where: { id: submission.id },
        data: { content },
      });

      await this.audit.record(
        {
          actorId: ctx.userId,
          action: "integrity.draft.autosave",
          entity: "submission",
          entityId: submission.id,
          schoolId: ctx.schoolId,
          metadata: { sequence },
        },
        tx,
      );
    });

    await this.enqueueAnalysis(ctx, submissionId, "AUTOSAVE");
  }

  // ---------------------------------------------------------------------------
  // 3. Submit: mark submitted, then enqueue detection.
  // ---------------------------------------------------------------------------
  async submit(ctx: TenantContext, submissionId: string, content: string): Promise<void> {
    await this.db.runAsTenant(ctx, async (tx) => {
      const submission = await this.loadOwnSubmission(tx, ctx, submissionId);
      await tx.submission.update({
        where: { id: submission.id },
        data: { content, status: "SUBMITTED", submittedAt: new Date() },
      });
      await this.audit.record(
        {
          actorId: ctx.userId,
          action: "integrity.submission.submit",
          entity: "submission",
          entityId: submission.id,
          schoolId: ctx.schoolId,
        },
        tx,
      );
    });

    await this.enqueueAnalysis(ctx, submissionId, "SUBMIT");
  }

  private async enqueueAnalysis(
    ctx: TenantContext,
    submissionId: string,
    trigger: IntegrityTrigger,
  ): Promise<void> {
    // schoolId + userId travel with the job so the worker re-establishes tenant
    // context. // SECURITY: they originate from the verified JWT, not the body.
    await this.queue.add(
      ANALYZE_SUBMISSION_JOB,
      { schoolId: ctx.schoolId, userId: ctx.userId, submissionId, trigger },
      { removeOnComplete: true, removeOnFail: 100 },
    );
  }

  // ---------------------------------------------------------------------------
  // 4. Worker entrypoint: run server detectors, persist SERVER signals.
  //    Called by the BullMQ processor with the job's tenant context.
  // ---------------------------------------------------------------------------
  async runDetection(job: AnalyzeSubmissionJob): Promise<{ written: number }> {
    const ctx: TenantContext = { schoolId: job.schoolId, userId: job.userId };

    return this.db.runAsTenant(ctx, async (tx) => {
      const submission = await tx.submission.findFirst({
        where: { id: job.submissionId },
      });
      if (!submission) return { written: 0 }; // gone / not visible under RLS

      // Defense in depth: re-check consent at detection time. If consent was
      // withdrawn since capture, we do NOT analyse the minor's work.
      const consented = await this.consent.hasIntegrityConsent(
        { studentId: submission.studentId, schoolId: job.schoolId },
        tx,
      );
      if (!consented) {
        await this.audit.record(
          {
            actorId: job.userId,
            action: "integrity.detection.skipped_no_consent",
            entity: "submission",
            entityId: submission.id,
            schoolId: job.schoolId,
          },
          tx,
        );
        return { written: 0 };
      }

      const context = await this.loadDetectionContext(tx, submission);
      const detectors = buildDetectors(this.embeddings);

      const produced: NewSignal[] = [];
      for (const d of detectors) {
        produced.push(...(await d.run(context)));
      }

      for (const s of produced) {
        await tx.integritySignal.create({
          data: {
            schoolId: job.schoolId,
            submissionId: submission.id,
            type: s.type,
            source: IntegritySignalSource.SERVER,
            severity: s.severity,
            confidence: s.confidence,
            evidence: s.evidence as Prisma.InputJsonValue,
            detector: s.detector,
          },
        });
      }

      // GR#5: the detection run (a write of minors' integrity data) is audited.
      await this.audit.record(
        {
          actorId: job.userId,
          action: "integrity.detection.run",
          entity: "submission",
          entityId: submission.id,
          schoolId: job.schoolId,
          metadata: {
            trigger: job.trigger,
            signalsWritten: produced.length,
            detectors: detectors.map((d) => d.name),
          },
        },
        tx,
      );

      return { written: produced.length };
    });
  }

  private async loadDetectionContext(
    tx: TenantTx,
    submission: {
      id: string;
      schoolId: string;
      assessmentId: string;
      studentId: string;
      content: string | null;
      contentKind: "PROSE" | "CODE";
    },
  ): Promise<SubmissionContext> {
    const [drafts, pasteSignals, cadenceRows, cohort] = await Promise.all([
      tx.submissionDraft.findMany({
        where: { submissionId: submission.id },
        orderBy: { sequence: "asc" },
      }),
      tx.integritySignal.findMany({
        where: {
          submissionId: submission.id,
          source: IntegritySignalSource.CLIENT,
          type: IntegritySignalType.PASTE,
        },
      }),
      tx.submissionTelemetry.findMany({
        where: { submissionId: submission.id, kind: "TYPING_CADENCE" },
      }),
      // Cohort = other submissions for the same assessment. RLS guarantees these
      // are same-tenant only, so similarity can never cross schools (GR#2).
      tx.submission.findMany({
        where: { assessmentId: submission.assessmentId, id: { not: submission.id } },
      }),
    ]);

    // evidence / payload are JSON columns (Prisma.JsonValue); narrow to the
    // shape the producing detector wrote.
    const pasteEvents: PasteEvidence[] = pasteSignals.map((row) => {
      const ev = row.evidence as unknown as PasteEvidence;
      return { pastedLength: ev.pastedLength, wasBlocked: ev.wasBlocked, at: ev.at };
    });
    const cadenceSamples: TypingCadenceSample[] = cadenceRows.map(
      (r) => r.payload as unknown as TypingCadenceSample,
    );

    return {
      submission,
      drafts,
      pasteEvents,
      cadenceSamples,
      cohort: cohort.map((c: { id: string; studentId: string; content: string | null }) => ({
        id: c.id,
        studentId: c.studentId,
        content: c.content,
      })),
    };
  }
}
