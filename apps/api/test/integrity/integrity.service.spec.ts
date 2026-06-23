// =============================================================================
// IntegrityService unit tests
// =============================================================================
// Covers, with in-memory fakes (no DB):
//  - every MUTATION hits the audit log (Golden Rule #5),
//  - consent gates ingest + detection (Golden Rule #5),
//  - ownership failures are 404 (not 403),
//  - NO code path writes a penalty/score/grade (Golden Rule #8).
// =============================================================================

import { IntegrityService } from "../../src/integrity/integrity.service";
import type {
  AuditEntry,
  TenantContext,
  TenantTx,
} from "../../src/integrity/integrity.foundation";

// ---- fakes ------------------------------------------------------------------
interface WriteRecord {
  model: string;
  op: "create" | "update";
  data: Record<string, unknown>;
}

function makeFakeTx(opts: {
  submission?: Record<string, unknown> | null;
  assessment?: Record<string, unknown> | null;
  lastDraft?: { sequence: number } | null;
}) {
  const writes: WriteRecord[] = [];
  const model = (name: string) => ({
    findFirst: jest.fn().mockResolvedValue(
      name === "submission" ? (opts.submission ?? null)
        : name === "assessment" ? (opts.assessment ?? null)
        : name === "submissionDraft" ? (opts.lastDraft ?? null)
        : null,
    ),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      writes.push({ model: name, op: "create", data });
      return Promise.resolve({ id: "new", ...data });
    }),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      writes.push({ model: name, op: "update", data });
      return Promise.resolve({ id: "x", ...data });
    }),
  });
  const tx = {
    submission: model("submission"),
    assessment: model("assessment"),
    submissionDraft: model("submissionDraft"),
    submissionTelemetry: model("submissionTelemetry"),
    integritySignal: model("integritySignal"),
    studentIntegrityExemption: model("studentIntegrityExemption"),
  } as unknown as TenantTx;
  return { tx, writes };
}

function makeService(fake: { tx: TenantTx }, consented = true) {
  const audit = { record: jest.fn<Promise<void>, [AuditEntry, TenantTx?]>().mockResolvedValue() };
  const consent = { hasIntegrityConsent: jest.fn().mockResolvedValue(consented) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const db = {
    runAsTenant: <T>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(fake.tx),
  };
  const service = new IntegrityService(
    db as never,
    audit as never,
    consent as never,
    queue as never,
    undefined,
  );
  return { service, audit, consent, queue };
}

const CTX: TenantContext = { schoolId: "school-A", userId: "student-1" };
const OWNED = { id: "sub-1", schoolId: "school-A", assessmentId: "a-1", studentId: "student-1" };
const ASSESSMENT_ON = { id: "a-1", schoolId: "school-A", integrityEnabled: true };

const PENALTY_KEY = /score|grade|penal|punish|sanction|verdict|cheat/i;

describe("IntegrityService", () => {
  describe("ingestClientSignals", () => {
    it("persists paste/focus as signals, cadence as telemetry, and audits", async () => {
      const fake = makeFakeTx({ submission: OWNED, assessment: ASSESSMENT_ON });
      const { service, audit } = makeService(fake);
      await service.ingestClientSignals(CTX, {
        assessmentId: "a-1",
        submissionId: "sub-1",
        signals: [
          { kind: "PASTE", fieldId: "f", pastedLength: 10, wasBlocked: true, at: new Date().toISOString() },
          { kind: "FOCUS_LOSS", cause: "BLUR", startedAt: new Date().toISOString(), durationMs: 5 },
          {
            kind: "TYPING_CADENCE", fieldId: "f",
            windowStartedAt: new Date().toISOString(), windowEndedAt: new Date().toISOString(),
            keyCount: 3, editKeyCount: 1, meanInterKeyMs: 100, stdevInterKeyMs: 30,
            maxBurstCharsPerSec: 4, netCharDelta: 3,
          },
        ],
      });
      const signalWrites = fake.writes.filter((w) => w.model === "integritySignal");
      const telemetryWrites = fake.writes.filter((w) => w.model === "submissionTelemetry");
      expect(signalWrites).toHaveLength(2);
      expect(telemetryWrites).toHaveLength(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integrity.signal.ingest" }),
        expect.anything(),
      );
    });

    it("drops telemetry when consent is absent (no writes)", async () => {
      const fake = makeFakeTx({ submission: OWNED, assessment: ASSESSMENT_ON });
      const { service } = makeService(fake, /* consented */ false);
      await service.ingestClientSignals(CTX, {
        assessmentId: "a-1",
        submissionId: "sub-1",
        signals: [{ kind: "FOCUS_LOSS", cause: "BLUR", startedAt: new Date().toISOString(), durationMs: 1 }],
      });
      expect(fake.writes).toHaveLength(0);
    });

    it("404s when the submission is not the caller's (no existence leak)", async () => {
      const fake = makeFakeTx({ submission: { ...OWNED, studentId: "someone-else" } });
      const { service } = makeService(fake);
      await expect(
        service.ingestClientSignals(CTX, { assessmentId: "a-1", submissionId: "sub-1", signals: [
          { kind: "FOCUS_LOSS", cause: "BLUR", startedAt: new Date().toISOString(), durationMs: 1 },
        ] }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("autosave + submit", () => {
    it("autosave appends a draft, updates content, audits, and enqueues", async () => {
      const fake = makeFakeTx({ submission: OWNED, lastDraft: { sequence: 2 } });
      const { service, audit, queue } = makeService(fake);
      await service.autosave(CTX, "sub-1", "hello");
      const drafts = fake.writes.filter((w) => w.model === "submissionDraft" && w.op === "create");
      expect(drafts[0].data.sequence).toBe(3);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integrity.draft.autosave" }),
        expect.anything(),
      );
      expect(queue.add).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger: "AUTOSAVE" }),
        expect.anything(),
      );
    });

    it("submit marks SUBMITTED, audits, and enqueues", async () => {
      const fake = makeFakeTx({ submission: OWNED });
      const { service, audit, queue } = makeService(fake);
      await service.submit(CTX, "sub-1", "final");
      const upd = fake.writes.find((w) => w.model === "submission" && w.op === "update");
      expect(upd?.data.status).toBe("SUBMITTED");
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integrity.submission.submit" }),
        expect.anything(),
      );
      expect(queue.add).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trigger: "SUBMIT" }),
        expect.anything(),
      );
    });
  });

  describe("runDetection", () => {
    const SUBMISSION = { ...OWNED, content: "a fully formed answer", contentKind: "PROSE" };

    it("writes only SERVER signals and audits the run when consented", async () => {
      const fake = makeFakeTx({ submission: SUBMISSION });
      const { service, audit } = makeService(fake);
      const res = await service.runDetection({
        schoolId: "school-A", userId: "student-1", submissionId: "sub-1", trigger: "SUBMIT",
      });
      const sigWrites = fake.writes.filter((w) => w.model === "integritySignal");
      expect(res.written).toBeGreaterThan(0);
      expect(sigWrites.every((w) => w.data.source === "SERVER")).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integrity.detection.run" }),
        expect.anything(),
      );
    });

    it("skips analysis and audits the skip when consent was withdrawn", async () => {
      const fake = makeFakeTx({ submission: SUBMISSION });
      const { service, audit } = makeService(fake, false);
      const res = await service.runDetection({
        schoolId: "school-A", userId: "student-1", submissionId: "sub-1", trigger: "SUBMIT",
      });
      expect(res.written).toBe(0);
      expect(fake.writes.filter((w) => w.model === "integritySignal")).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integrity.detection.skipped_no_consent" }),
        expect.anything(),
      );
    });
  });

  describe("Golden Rule #8 — no automatic penalty path", () => {
    it("exposes no method that could penalise/score/grade a student", () => {
      const methods = Object.getOwnPropertyNames(IntegrityService.prototype);
      expect(methods.filter((m) => PENALTY_KEY.test(m))).toHaveLength(0);
    });

    it("never writes a penalty/score/grade field on any DB write", async () => {
      const fake = makeFakeTx({
        submission: { ...OWNED, content: "x", contentKind: "PROSE" },
      });
      const { service } = makeService(fake);
      await service.submit(CTX, "sub-1", "final");
      await service.runDetection({
        schoolId: "school-A", userId: "student-1", submissionId: "sub-1", trigger: "SUBMIT",
      });
      for (const w of fake.writes) {
        for (const key of Object.keys(w.data)) {
          expect(key).not.toMatch(PENALTY_KEY);
        }
      }
    });
  });
});
